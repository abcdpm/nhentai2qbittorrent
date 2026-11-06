package LANraragi::Plugin::Metadata::nHentaiCustom;

use strict;
use warnings;
use utf8;

use URI::Escape;
use Mojo::UserAgent;
use Mojo::DOM;

use LANraragi::Model::Plugins;
use LANraragi::Utils::Logging qw(get_plugin_logger);
use LANraragi::Utils::Redis qw(redis_decode);

sub plugin_info {
    return (
        name        => "nHentai (Custom Fixed)",
        type        => "metadata",
        namespace   => "nhcustom",
        login_from  => "nhcustomcf",
        author      => "Difegue, Fixed by Paccu",
        version     => "3.1 (CF Diagnostics)",
        description => "Extracts tags from HTML DOM (no API, avoids 429 limits). Browser-like request headers + Cloudflare challenge detection with actionable diagnostics. Supports community tags. ID resolution: trailing [id] -> title search -> title without [id].",
        icon =>
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA\nB3RJTUUH4wYCFA8s1yKFJwAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmUH\nAAACL0lEQVQ4y6XTz0tUURQH8O+59773nLFcaGWTk4UUVCBFiJs27VxEQRH0AyRo4x8Q/Qtt2rhr\nU6soaCG0KYKSwIhMa9Ah+yEhZM/5oZMG88N59717T4sxM8eZCM/ycD6Xwznn0pWhG34mh/+PA8mk\n8jO5heziP0sFYwfgMDFQJg4IUjmquSFGG+OIlb1G9li5kykgTgvzSoUCaIYlo8/Igcjpj5wOkARp\n8AupP0uzJLijCY4zzoXOxdBLshAgABr8VOp7bpAXDEI7IBrhdksnjNr3WzI4LaIRV9fk2iAaYV/y\nA1dPiYjBAALgpQxnhV2XzTCAGWGeq7ACBvCdzKQyTH+voAm2hGlpcmQt2Bc2K+ymAhWPxTzPDQLt\nOKo1FiNBQaArq9WNRQwEgKl7XQ1duzSRSn/88vX0qf7DPQddx1nI5UfHxt+m0sLYPiP3shRAG8MD\nok1XEEXR/EI2ly94nrNYWG6Nx0/2Hp2b94dv34mlZge1e4hVCJ4jc6tl9ZP803n3/i4lpdyzq2N0\n7M3DkSeF5ZVYS8v1qxcGz5+5eey4nPDbmGdE9FpGeWErVNe2tTabX3r0+Nk3PwOgXFkdfz99+exA\nMtFZITEt9F23mpLG0hYTVQCKpfKPlZ/rqWKpYoAPcTmpginW76QBbb0OBaBaDdjaDbNlJmQE3/d0\nMYoaybU9126oPkrEhpr+U2wjtoVVGBowkslEsVSupRKdu0Mduq7q7kqExjSS3V2dvwDLavx0eczM\neAAAAABJRU5ErkJggg==",
        parameters  => [ { type => "bool", desc => "Save archive title" } ],
        oneshot_arg => "nHentai Gallery URL"
    );
}

sub get_tags {
    my $self = shift;
    my $lrr_info = shift;

    my $savetitle = 0;
    if (ref($lrr_info) eq 'HASH') {
        $savetitle = $lrr_info->{custom_args}->[0] || 0;
    } else {
        $savetitle = $_[3] || 0;
        $lrr_info = { archive_title => $lrr_info, existing_tags => $_[0] };
    }

    my $ua = $lrr_info->{user_agent} || Mojo::UserAgent->new;
    my $logger = get_plugin_logger();
    my $galleryID = "";
    my $fromID = 0;

    my $oneshot = $lrr_info->{oneshot_param} // '';
    my $tags    = $lrr_info->{existing_tags} // '';
    my $title   = redis_decode($lrr_info->{archive_title} // '');
    $title =~ s/\.(zip|rar|cbz|cbr|tar|7z|pdf)$//i;

    if ( $oneshot =~ /.*\/g\/([0-9]+).*/ ) {
        $galleryID = $1;
        $logger->info("Using gallery $galleryID from oneshot args.");
    } elsif ( $tags =~ /.*source:\s*(?:https?:\/\/)?nhentai\.net\/g\/([0-9]*).*/gi ) {
        $galleryID = $1;
        $logger->info("Using gallery $galleryID from source tag.");
    } elsif ( $title =~ /[\[\(【]\s*([0-9]{3,9})\s*[\]\)】]\s*$/ ) {
        # (1) 优先识别压缩包名称末端的 [id]，按 ID 抓取
        $galleryID = $1;
        $fromID = 1;
        $logger->info("Using gallery $galleryID from trailing [id].");
    } else {
        # (2) 没有 [id] -> 按压缩包名称抓取
        $logger->info("Searching gallery by exact title...");
        $galleryID = get_gallery_id_from_title( $title, $ua );
    }

    if ( !$galleryID ) {
        my $message = "No matching nHentai Gallery Found!";
        $logger->info($message);
        die "${message}\n";
    }

    $logger->info("Detected nHentai gallery ID is: $galleryID");
    my %hashdata;
    my $ok = eval { %hashdata = get_tags_from_NH( $galleryID, $ua, $savetitle ); 1; };

    if ( !$ok ) {
        my $err = $@;
        # Cloudflare 挑战是「整站入口被拦」，不是本子抓不到：直接报错，别再做「去 [id] 搜标题」的无谓重试
        if ($fromID && $err !~ /Cloudflare 挑战页拦截/) {
            # (3) 有 [id] 但抓不到 -> 去掉 [id] 后按剩余名称抓取
            my $stripped = $title;
            $stripped =~ s/\s*[\[\(【]\s*[0-9]{3,9}\s*[\]\)】]\s*$//;
            $stripped =~ s/\s+$//;
            $logger->info("Fetching by [id] failed ($err), retrying by title without [id]...");
            $galleryID = get_gallery_id_from_title( $stripped, $ua );
            if ( !$galleryID ) {
                my $message = "No matching nHentai Gallery Found!";
                $logger->info($message);
                die "${message}\n";
            }
            $logger->info("Detected nHentai gallery ID is: $galleryID");
            %hashdata = get_tags_from_NH( $galleryID, $ua, $savetitle );
        } else {
            die $err;
        }
    }

    $logger->info( "Sending the following tags to LRR: " . $hashdata{tags} );
    return %hashdata;
}

# ---------------------------------------------------------------------------
# Cloudflare 友好请求工具（3.1 新增，不依赖任何官方 API）
#
# 背景：nhentai.net 现在对 /g/{id}/ 与 /search 由 Cloudflare 托管挑战（Managed
# Challenge）保护。请求缺少 cf_clearance / UA 与之不一致 / 出口 IP 不同时，直接
# 返回 403 + "Just a moment..." 挑战页——这不是「本子不存在」，也不是页面结构变化。
# 这里把 403 翻译成可操作的日志，并把请求头补成与浏览器一致以提高通过率。
# ---------------------------------------------------------------------------

# 站点根地址：默认 nhentai.net；可用环境变量 NHENTAI_BASE_URL 覆盖为镜像/自建反代
sub _nh_base_url {
    my $base = $ENV{NHENTAI_BASE_URL} || 'https://nhentai.net';
    $base =~ s/\s+//g;
    $base =~ s{/+$}{};
    return $base;
}

# 取 $ua 当前的 User-Agent（CF 的 cf_clearance 与 UA 强绑定，必须原样透传）
sub _ua_string {
    my ($ua) = @_;
    my $str = '';
    if ($ua) {
        eval { $str = $ua->transactor->name // '' };
        if ( !$str ) { eval { $str = $ua->http_headers->header('User-Agent') // '' } }
    }
    $str =~ s/^\s+|\s+$//g;
    return $str;
}

# 构造与 UA 完全一致的浏览器请求头（CF 会比对 UA / sec-ch-ua / sec-fetch-* 一致性）
sub _browser_headers {
    my ($ua) = @_;
    my $ua_str = _ua_string($ua);

    my %h = (
        'Accept'                    => 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language'           => 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Upgrade-Insecure-Requests' => '1',
        'Sec-Fetch-Dest'            => 'document',
        'Sec-Fetch-Mode'            => 'navigate',
        'Sec-Fetch-Site'            => 'none',
        'Sec-Fetch-User'            => '?1',
        'Referer'                   => _nh_base_url() . '/',
    );

    my $brands = '';
    if    ( $ua_str =~ /Edg\/(\d+)/ )    { $brands = qq{"Microsoft Edge";v="$1", "Chromium";v="$1", "Not_A Brand";v="99"} }
    elsif ( $ua_str =~ /Chrome\/(\d+)/ ) { $brands = qq{"Chromium";v="$1", "Google Chrome";v="$1", "Not_A Brand";v="99"} }

    if ($brands) {
        $h{'sec-ch-ua'}          = $brands;
        $h{'sec-ch-ua-mobile'}   = ( $ua_str =~ /Mobile|Android/ ) ? '?1' : '?0';
        $h{'sec-ch-ua-platform'} = $ua_str =~ /Windows/   ? '"Windows"'
                                 : $ua_str =~ /Macintosh/ ? '"macOS"'
                                 : $ua_str =~ /Android/   ? '"Android"'
                                 : $ua_str =~ /Linux/     ? '"Linux"'
                                 :                          q{""};
        $h{'User-Agent'} = $ua_str;
    }

    return \%h;
}

# 汇总请求上下文，用于 403/挑战页时输出可操作的诊断日志
sub _request_diag {
    my ( $ua, $url ) = @_;
    my $ua_str = _ua_string($ua) || '(未设置，使用 Mojo 默认 UA)';

    my ( $count, $has_cf ) = ( 0, 0 );
    my @names;
    eval {
        my @cookies = $ua->cookie_jar ? $ua->cookie_jar->all : ();
        $count = scalar @cookies;
        for my $c (@cookies) {
            my $n = eval { $c->name } // '';
            push @names, $n;
            $has_cf = 1 if $n eq 'cf_clearance';
        }
    };
    my $shown = @names > 8 ? join( ',', @names[ 0 .. 7 ] ) . ',…' : join( ',', @names );

    return sprintf(
        'URL=%s | UA=%s | cookie 数=%d[%s] | cf_clearance=%s',
        $url, $ua_str, $count, $shown, $has_cf ? '有' : '缺失'
    );
}

# 识别 Cloudflare 挑战页（区别于「本子不存在 / 已删除」这类真错误）
sub _is_challenge_page {
    my ( $res, $body ) = @_;
    my $code      = $res ? ( $res->code // 0 ) : 0;
    my $mitigated = '';
    eval { $mitigated = $res->headers->header('cf-mitigated') // '' };
    return "cf-mitigated=$mitigated（Cloudflare 托管挑战）" if $mitigated =~ /challenge/i;

    if ( defined $body && $body =~ /<title>\s*Just a moment/i ) {
        return "HTTP $code Cloudflare 挑战页（Just a moment...）";
    }
    if ( ( $code == 403 || $code == 503 ) && defined $body
        && $body =~ /(?:cf_chl_opt|challenge-platform|\/cdn-cgi\/challenge-platform)/i )
    {
        return "HTTP $code Cloudflare 挑战脚本";
    }
    return '';
}

# 统一的 GET：浏览器化请求头 + 指数退避重试 3 次 + 挑战页识别 + 详细报错
sub _nh_get {
    my ( $ua, $url, $what ) = @_;
    my $logger  = get_plugin_logger();
    my $headers = _browser_headers($ua);

    my $old_timeout = eval { $ua->inactivity_timeout };
    eval { $ua->inactivity_timeout(25) };

    my $last_err = '';
    for my $attempt ( 1 .. 3 ) {
        my $tx = eval { $ua->build_tx( GET => $url ) };
        if ( !$tx ) {
            my $e = $@ || 'build_tx 失败';
            $last_err = $e;
            if ( $attempt < 3 ) { sleep( 2 * $attempt ); next }
            eval { $ua->inactivity_timeout($old_timeout) } if defined $old_timeout;
            die "Error retrieving gallery from nHentai! (请求构造失败: $e) — $url\n";
        }
        $tx->req->headers->header( %{$headers} );
        eval { $ua->start($tx) };

        my $res       = $tx->result;
        my $code      = $res ? ( $res->code // 0 ) : 0;
        my $body      = $res ? ( $res->body // '' ) : '';
        my $challenge = _is_challenge_page( $res, $body );

        if ($challenge) {
            $logger->warn("[$what] 第 $attempt/3 次请求被 Cloudflare 拦截：$challenge");
            $logger->warn( '[' . $what . '] ' . _request_diag( $ua, $url ) );
            $last_err = $challenge;
            if ( $attempt < 3 ) { sleep( 3 * $attempt ); next }

            eval { $ua->inactivity_timeout($old_timeout) } if defined $old_timeout;
            die "Error retrieving gallery from nHentai! (Code: $code) —— Cloudflare 挑战页拦截（$challenge），不是本子不存在。\n"
              . "排查清单：1) cf_clearance 已过期（重新从浏览器复制 Cookie）；2) 请求 UA 与获取 Cookie 的浏览器 UA 不一致；"
              . "3) LRR 机器出口 IP 与浏览器不同（浏览器走代理/VPN 时必失败）；4) Cloudflare 校验非浏览器 TLS 指纹（Mojo::UserAgent 无 Chrome 指纹）；"
              . "5) 可设置环境变量 NHENTAI_BASE_URL 指向可用镜像/自建反代。\n"
              . _request_diag( $ua, $url ) . "\n";
        }

        if ( $code == 404 ) {
            eval { $ua->inactivity_timeout($old_timeout) } if defined $old_timeout;
            die "Error retrieving gallery from nHentai! (Code: 404) — 本子不存在或已删除（$url）\n";
        }

        if ( !$res || $res->is_error ) {
            $logger->warn("[$what] 第 $attempt/3 次请求失败：HTTP $code（$url）");
            $last_err = "HTTP $code";
            if ( $attempt < 3 ) { sleep( 2 * $attempt ); next }
            eval { $ua->inactivity_timeout($old_timeout) } if defined $old_timeout;
            die "Error retrieving gallery from nHentai! (Code: $code) — $last_err（$url）\n";
        }

        eval { $ua->inactivity_timeout($old_timeout) } if defined $old_timeout;
        return $res;
    }

    eval { $ua->inactivity_timeout($old_timeout) } if defined $old_timeout;
    die "Error retrieving gallery from nHentai! ($last_err) — $url\n";
}

sub get_gallery_dom_by_title {
    my ( $title, $ua ) = @_;
    my $logger = get_plugin_logger();

    $title =~ s/-|'/ /g;
    my $query = uri_escape_utf8($title);
    $query =~ s/%20/+/g;

    my $URL = _nh_base_url() . "/search?q=" . $query;
    $logger->info("[DEBUG] Requesting URL: $URL");

    $ua = Mojo::UserAgent->new unless $ua;
    $ua->max_redirects(5);

    # 搜索页同样受 Cloudflare 挑战保护：统一走 _nh_get（重试 + 挑战页诊断）
    my $res = _nh_get( $ua, $URL, 'search' );
    return $res->dom;
}

sub get_gallery_id_from_title {
    my ( $title, $ua ) = @_;

    if ( $title =~ /\{(\d*)\}.*$/gm ) { return $1; }

    my $dom = get_gallery_dom_by_title( $title, $ua );
    if ($dom && $dom->at('.cover')) {
        my $gURL = $dom->at('.cover')->attr('href');
        if ( $gURL =~ /\/g\/(\d*)\//gm ) { return $1; }
    }
    return;
}

sub get_html_from_NH {
    my ( $gID, $ua ) = @_;
    my $logger = get_plugin_logger();
    my $URL    = _nh_base_url() . "/g/$gID/";

    $ua = Mojo::UserAgent->new unless $ua;
    $ua->max_redirects(5);

    $logger->info("GET $URL（浏览器化请求头 + 挑战页识别，最多重试 3 次）");
    my $res  = _nh_get( $ua, $URL, "gallery $gID" );
    my $body = $res->body // '';

    # 页面结构自检：既区分「被 CF 拦截」也区分「nhentai 改版」
    if ( $body !~ /tag-container/i && $body !~ /id="tags"/i && $body !~ /class="[^"]*title/i ) {
        $logger->warn("gallery $gID 返回内容不含已知结构（tag-container/#tags/title），长度="
              . length($body)
              . '，可能是页面改版或被拦截页' );
    }

    return $res->dom;
}

sub get_tags_from_NH {
    my ( $gID, $ua, $savetitle ) = @_;
    my %hashdata = ( tags => "" );
    my $logger = get_plugin_logger();

    $logger->info("Fetching HTML DOM to extract tags (V2 API bypassed to avoid 429 limits)...");
    my $dom = get_html_from_NH( $gID, $ua );

    if ($dom) {
        my @tags = ();

        # 官方页面用 .tag-container a；旧版/镜像用 #tags a；社区版用 .tagchip
        my @anchors = $dom->find('.tag-container a, #tags a, .tagchip')->each;
        for my $a (@anchors) {
            my $href      = $a->attr('href') // '';
            my $name_node = $a->at('.name') || $a;

            # 过滤掉内部包含的诸如图标之类的多余节点，提取纯文本
            my $name = $name_node ? $name_node->all_text : "";
            $name =~ s/^\s+|\s+$//g;

            # 正则匹配，避开如 "Pages" 这种特殊 href ("/search/?q=pages")
            if ($name && $href =~ /\/([a-z-]+)\/([^\/]+)\//) {
                my $namespace = $1;
                if ($namespace eq 'tag') {
                    push( @tags, $name );
                } elsif ($namespace =~ /^(language|category|character|parody|artist|group)$/) {
                    push( @tags, "$namespace:$name" );
                }
            }
        }

        if ( !@tags ) {
            $logger->warn("gallery $gID 未解析到任何标签：页面可能是挑战页/改版（DOM 中未找到 tag-container / #tags / .tagchip）");
        }

        push( @tags, "source:nhentai.net/g/$gID" ) if ( @tags > 0 );
        $hashdata{tags} = join( ', ', @tags );

        if ($savetitle) {
            my $title_node = $dom->at('#info h1 .pretty')
              || $dom->at('#info h1 .pretty-format')
              || $dom->at('#info h2 .pretty')
              || $dom->at('#info h2 .pretty-format')
              || $dom->at('#info h1')
              || $dom->at('h1.title');
            if ($title_node) {
                $hashdata{title} = $title_node->all_text;
            }
        }
    }
    
    return %hashdata;
}

1;

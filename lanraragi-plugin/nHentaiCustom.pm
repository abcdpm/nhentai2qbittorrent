package LANraragi::Plugin::Metadata::nHentaiCustom;

use strict;
use warnings;
use utf8;

use URI::Escape ();
use Mojo::UserAgent;
use Mojo::DOM;
use Mojo::JSON qw(decode_json);

use LANraragi::Model::Plugins;
use LANraragi::Utils::Logging qw(get_plugin_logger);
use LANraragi::Utils::Redis qw(redis_decode);

# 插件级状态：API Key（插件设置页 custom_args[1]）与上次 API 请求时间（本地节流用）
our $NH_API_KEY  = '';
our $NH_API_LAST = 0;

sub plugin_info {
    return (
        name        => "nHentai (Custom Fixed)",
        type        => "metadata",
        namespace   => "nhcustom",
        login_from  => "nhcustomcf",
        author      => "Difegue, Fixed by Paccu",
        version     => "3.2 (API-first + CF fallback)",
        description => "Uses the official v2 API first (JSON, no cookie needed; 20/min anon, 45/min with API key) and falls back to HTML DOM scraping with browser-like headers and Cloudflare challenge detection. ID resolution: trailing [id] -> v2 search -> HTML search. Env: NHENTAI_BASE_URL, NHENTAI_API_KEY, NHENTAI_API_DISABLE, NHENTAI_API_MIN_INTERVAL.",
        icon =>
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA\nB3RJTUUH4wYCFA8s1yKFJwAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmUH\nAAACL0lEQVQ4y6XTz0tUURQH8O+59773nLFcaGWTk4UUVCBFiJs27VxEQRH0AyRo4x8Q/Qtt2rhr\nU6soaCG0KYKSwIhMa9Ah+yEhZM/5oZMG88N59717T4sxM8eZCM/ycD6Xwznn0pWhG34mh/+PA8mk\n8jO5heziP0sFYwfgMDFQJg4IUjmquSFGG+OIlb1G9li5kykgTgvzSoUCaIYlo8/Igcjpj5wOkARp\n8AupP0uzJLijCY4zzoXOxdBLshAgABr8VOp7bpAXDEI7IBrhdksnjNr3WzI4LaIRV9fk2iAaYV/y\nA1dPiYjBAALgpQxnhV2XzTCAGWGeq7ACBvCdzKQyTH+voAm2hGlpcmQt2Bc2K+ymAhWPxTzPDQLt\nOKo1FiNBQaArq9WNRQwEgKl7XQ1duzSRSn/88vX0qf7DPQddx1nI5UfHxt+m0sLYPiP3shRAG8MD\nok1XEEXR/EI2ly94nrNYWG6Nx0/2Hp2b94dv34mlZge1e4hVCJ4jc6tl9ZP803n3/i4lpdyzq2N0\n7M3DkSeF5ZVYS8v1qxcGz5+5eey4nPDbmGdE9FpGeWErVNe2tTabX3r0+Nk3PwOgXFkdfz99+exA\nMtFZITEt9F23mpLG0hYTVQCKpfKPlZ/rqWKpYoAPcTmpginW76QBbb0OBaBaDdjaDbNlJmQE3/d0\nMYoaybU9126oPkrEhpr+U2wjtoVVGBowkslEsVSupRKdu0Mduq7q7kqExjSS3V2dvwDLavx0eczM\neAAAAABJRU5ErkJggg==",
        parameters  => [
            { type => "bool",   desc => "Save archive title" },
            { type => "string", desc => "nhentai API Key (optional; raises v2 API limit from 20 to 45 req/min)" }
        ],
        oneshot_arg => "nHentai Gallery URL"
    );
}

sub get_tags {
    my $self = shift;
    my $lrr_info = shift;

    my $savetitle = 0;
    my $api_key   = '';
    if (ref($lrr_info) eq 'HASH') {
        my $args = ref( $lrr_info->{custom_args} ) eq 'ARRAY' ? $lrr_info->{custom_args} : [];
        $savetitle = $args->[0] || 0;
        $api_key   = $args->[1] // '';
    } else {
        $savetitle = $_[3] || 0;
        $lrr_info = { archive_title => $lrr_info, existing_tags => $_[0] };
    }
    $api_key =~ s/^\s+|\s+$//g;
    $NH_API_KEY = $api_key;    # 插件参数优先；为空时 _nh_api_get 回落到环境变量 NHENTAI_API_KEY

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

# ---------------------------------------------------------------------------
# 官方 v2 API 通道（3.2 新增）
#
# 为什么要有它：HTML 页面（/g/{id}/、/search）在 Cloudflare 托管挑战后面，
# cf_clearance 有效期只有几十分钟，动不动就 403；而 /api/v2/* 是**纯 JSON 接口，
# 实测不带任何 cookie 也返回 200**（无 cf-mitigated / 无挑战页），因此元数据
# 可以完全不依赖 cookie。
#
# 实测频率上限（2026-11，匿名 IP，连续打满实测）：
#   GET /api/v2/galleries/{id}   20 次/分钟/IP   ← 第 21 次即 429（x-ratelimit-limit: 20, retry-after: 60）
#   GET /api/v2/search           10 次/分钟/IP
#   GET /api/v2/galleries        15 次/分钟/IP（列表，无搜索参数）
#   GET /api/v2/galleries/{id}/related  12 次/分钟/IP
#   GET /api/v2/galleries/popular        8 次/分钟/IP
# 带 API Key（Authorization: Key xxx，见 nhentai 账号设置 → API Keys）：
#   gallery 详情 45/分钟、搜索 20/分钟、列表 30/分钟
# 429 响应头携带 retry-after，按它退避即可；请求过快只会 429，不会被 CF 挑战。
#
# 因此：默认「API 优先 + HTML 回退」，两点关键策略：
#   1) 节流是**全局**的（用 LRR 自带 Redis 存上次请求时间），跨 worker 进程也守得住 20/min；
#      默认速率：无 Key 3.2s/次，配了 API Key 自动放宽到 1.5s/次
#   2) 429 时按 retry-after 等待（默认最多等 90s，足够熬过 nhentai 的 60s 窗口）；
#      等不起且手上没有 cf_clearance 时直接报明确错误，不去白跑注定被挑战的 HTML
#   NHENTAI_API_KEY          可选，设置后 45 次/分钟（节流自动放宽到 1.5s）
#   NHENTAI_API_DISABLE=1    完全禁用 API，只用 HTML DOM（旧行为）
#   NHENTAI_API_MIN_INTERVAL 本地最小请求间隔（秒；不设置=自动，0=不节流）
#   NHENTAI_API_MAX_WAIT     429 时最多等待的秒数（默认 90；retry-after 更大则放弃等待）
# ---------------------------------------------------------------------------

sub _nh_effective_key {
    my $key = $NH_API_KEY;
    $key = $ENV{NHENTAI_API_KEY} // '' unless length $key;
    $key =~ s/^\s+|\s+$//g;
    return $key;
}

# 本地最小请求间隔（秒）：
#   - 显式设置 NHENTAI_API_MIN_INTERVAL 时以它为准（0 = 不节流）
#   - 否则按是否带 API Key 自动决定：有 Key（45/min）→ 1.5s（≈40/min，留余量）；无 Key（20/min）→ 3.2s
sub _nh_api_min_interval {
    my $v = $ENV{NHENTAI_API_MIN_INTERVAL};
    return $v + 0 if defined $v && $v =~ /^\d+(?:\.\d+)?$/;
    return length( _nh_effective_key() ) ? 1.5 : 3.2;
}

sub _nh_sleep {
    my ($secs) = @_;
    return unless defined $secs && $secs > 0;
    select( undef, undef, undef, $secs );
}

# 是否真的拿到了 cf_clearance（决定「API 限流时回退 HTML 有没有意义」）
sub _has_cf_clearance {
    my ($ua) = @_;
    return 0 unless $ua;
    my $found = 0;
    eval {
        my @cookies = $ua->cookie_jar ? $ua->cookie_jar->all : ();
        for my $c (@cookies) {
            my $n = eval { $c->name } // '';
            $found = 1 if $n eq 'cf_clearance';
        }
    };
    return $found;
}

# 全局（跨进程）节流：
# LRR 的自动插件跑在多个 worker 进程里，仅靠进程内时间戳会各自为政 —— 总速率 ×worker 数，
# 直接把 20 次/分钟的配额打爆（实测现象：一次性批量打标签后全站 429 60s）。
# 因此优先用 LRR 自带的 Redis 存「最近一次 API 请求时间」，实现真正的全局节流；Redis 不可用时回落进程内。
sub _nh_api_throttle {
    my $gap = _nh_api_min_interval();
    return if $gap <= 0;

    my $redis_last;
    my $has_redis = eval {
        $redis_last = LANraragi::Utils::Redis::redis_get('nhcustom_api_last_call');
        1;
    };

    if ($has_redis) {
        $redis_last = 0
          unless defined $redis_last && "$redis_last" =~ /^\d+(?:\.\d+)?$/;
        my $wait = $redis_last + $gap - time();
        _nh_sleep($wait) if $wait > 0;
        my $now = time();
        eval { LANraragi::Utils::Redis::redis_set( 'nhcustom_api_last_call', $now ) };
        $NH_API_LAST = $now;
        return;
    }

    my $wait = $NH_API_LAST + $gap - time();
    _nh_sleep($wait) if $wait > 0;
    $NH_API_LAST = time();
}

# 请求 v2 API，返回 ( $json_hashref, '' ) 或 ( undef, $err )
# $err 取值：'not_found'（真 404）/ 'rate_limited(Ns)' / 'HTTP xxx' / '网络错误: ...'
sub _nh_api_get {
    my ( $ua, $path ) = @_;
    my $logger = get_plugin_logger();
    my $url    = _nh_base_url() . $path;
    $ua = Mojo::UserAgent->new unless $ua;

    my $key = _nh_effective_key();

    my $max_wait = $ENV{NHENTAI_API_MAX_WAIT};
    $max_wait = 90 unless defined $max_wait && $max_wait =~ /^\d+$/;

    my $last = '';
    for my $attempt ( 1 .. 3 ) {
        _nh_api_throttle();

        my $tx = eval { $ua->build_tx( GET => $url ) };
        if ( !$tx ) {
            $last = "build_tx 失败: $@";
            last;
        }
        my $h = $tx->req->headers;
        $h->header( 'Accept'  => 'application/json' );
        $h->header( 'Referer' => _nh_base_url() . '/' );
        $h->header( 'Authorization' => "Key $key" ) if length $key;

        my $res = eval { $ua->start($tx)->result };
        if ( !$res ) {
            $last = '网络错误: ' . ( $@ || 'unknown' );
            next;
        }

        my $code = $res->code // 0;
        my $body = $res->body // '';

        return ( undef, 'not_found' ) if $code == 404;

        if ( $code == 429 ) {
            my $ra = $res->headers->header('retry-after') // '';
            $ra =~ s/\D//g;
            $ra = 60 unless length $ra;
            if ( $ra > $max_wait ) {
                $logger->warn("v2 API 限流：需等待 ${ra}s（超过 NHENTAI_API_MAX_WAIT=$max_wait），直接回退 HTML");
                return ( undef, "rate_limited(${ra}s)" );
            }
            $logger->warn("v2 API 触发限流（429），${ra}s 后重试（第 $attempt/3 次）");
            _nh_sleep($ra);
            $last = 'rate_limited';
            next;
        }

        if ( $code >= 400 ) {
            $last = 'HTTP ' . $code;
            $last .= ' Cloudflare 挑战页' if _is_challenge_page( $res, $body );
            last;
        }

        my $json = eval { decode_json($body) };
        if ( !$json ) {
            $last = 'JSON 解析失败（' . length($body) . " 字节）";
            last;
        }
        return ( $json, '' );
    }

    return ( undef, $last || 'unknown error' );
}

# v2 gallery JSON → LRR 的 %hashdata（tags 字符串 + 可选 title）
# 命名空间规则与 HTML 路径保持一致：tag 无前缀，其余 language/category/character/parody/artist/group 带前缀
sub _api_hashdata {
    my ( $json, $gid, $savetitle ) = @_;
    my %hashdata = ( tags => '' );
    return %hashdata unless ref($json) eq 'HASH';

    my @tags = ();
    for my $t ( @{ $json->{tags} || [] } ) {
        next unless ref($t) eq 'HASH';
        my $type = $t->{type} // '';
        my $name = $t->{name} // '';
        $name =~ s/^\s+|\s+$//g;
        next unless length $name;
        if ( $type eq '' || $type eq 'tag' ) {
            push( @tags, $name );
        } elsif ( $type =~ /^(language|category|character|parody|artist|group)$/ ) {
            push( @tags, "$type:$name" );
        }
    }

    push( @tags, "source:nhentai.net/g/$gid" ) if (@tags);
    $hashdata{tags} = join( ', ', @tags );

    if ($savetitle) {
        my $t      = $json->{title};
        my $pretty = '';
        if ( ref($t) eq 'HASH' ) {
            $pretty = $t->{pretty} // $t->{english} // $t->{japanese} // '';
        } elsif ( !ref($t) ) {
            $pretty = $t // '';
        }
        $pretty =~ s/^\s+|\s+$//g;
        $hashdata{title} = $pretty if length $pretty;
    }

    return %hashdata;
}

# 标题归一化：只保留字母数字（去大小写/标点/空白差异），用于在搜索结果的候选里挑最像的那个
sub _norm_title {
    my ($s) = @_;
    $s = '' unless defined $s;
    $s =~ s/^\s+|\s+$//g;
    $s =~ s/[\r\n\t]+/ /g;
    $s = lc $s;
    $s =~ s/[^\p{L}\p{N}]+//g;
    return $s;
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
    # 空名 Cookie = login 插件注入格式不对（不能只写 cf_clearance 的值，要写成 cf_clearance=xxx）
    my $hint = '';
    $hint = ' | ⚠ 检测到空名 Cookie：nHentai CF Bypass 的 Cookie 字段格式可能不对（应为 cf_clearance=…; __cf_bm=…）'
      if grep { !defined($_) || $_ eq '' } @names;

    return sprintf(
        'URL=%s | UA=%s | cookie 数=%d[%s] | cf_clearance=%s%s',
        $url, $ua_str, $count, $shown, $has_cf ? '有' : '缺失', $hint
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
    my $query = URI::Escape::uri_escape_utf8($title);
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
    my $logger = get_plugin_logger();

    if ( $title =~ /\{(\d*)\}.*$/gm ) { return $1; }

    # (I) v2 搜索优先：10 次/分钟（匿名）/ 20 次（API Key），不做 CF 挑战、不需要 cookie
    if ( !$ENV{NHENTAI_API_DISABLE} ) {
        my $q = $title;
        $q =~ s/-|'/ /g;
        $q =~ s/^\s+|\s+$//g;
        if ( length $q ) {
            my ( $json, $err ) =
              _nh_api_get( $ua, '/api/v2/search?query=' . URI::Escape::uri_escape_utf8($q) . '&page=1' );
            if ($json) {
                my @rs = grep { ref($_) eq 'HASH' && $_->{id} } @{ $json->{result} || [] };
                if (@rs) {
                    # 优先取标题归一化后完全一致的候选，其次取相关度第一条
                    my $want = _norm_title($q);
                    my ($best) = grep { _norm_title( $_->{english_title} // '' ) eq $want } @rs;
                    $best ||= $rs[0];
                    $logger->info( "v2 搜索命中 gallery id=" . $best->{id} );
                    return $best->{id};
                }
                $logger->info('v2 搜索无结果，回退 HTML 搜索');
            } elsif ( $err ne 'not_found' ) {
                $logger->warn("v2 搜索不可用（$err），回退 HTML 搜索");
            }
        }
    }

    # (II) HTML 搜索回退
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

    # ---- (A) 官方 v2 API 优先：无 Cloudflare 挑战、不需要 cookie ----
    # 限流：gallery 详情 20 次/分钟（匿名）/ 45 次（API Key）；本地节流 + 429 退避见 _nh_api_get
    if ( !$ENV{NHENTAI_API_DISABLE} ) {
        my ( $json, $err ) = _nh_api_get( $ua, "/api/v2/galleries/$gID" );
        if ($json) {
            my %api = _api_hashdata( $json, $gID, $savetitle );
            if ( $api{tags} ) {
                $logger->info(
                    "v2 API 命中：gallery $gID（tags="
                      . scalar( @{ $json->{tags} || [] } )
                      . ', media_id='
                      . ( $json->{media_id} // '?' )
                      . ', pages='
                      . ( $json->{num_pages} // '?' ) . '）'
                );
                return %api;
            }
            $logger->warn("v2 API 返回 200 但没有标签（gallery $gID），回退 HTML DOM");
        } elsif ( $err eq 'not_found' ) {
            die "Error retrieving gallery from nHentai! (Code: 404) — 本子 $gID 不存在或已删除\n";
        } elsif ( $err =~ /^rate_limited/ ) {
            # 限流 ≠ 接口不可用：只有真的拿到 cf_clearance 时才值得回退 HTML（否则回退必然被 CF 挑战）
            if ( _has_cf_clearance($ua) ) {
                $logger->warn("v2 API 限流（$err），已持有 cf_clearance，回退 HTML DOM");
            } else {
                die "Error retrieving gallery from nHentai! — v2 API 触发限流（$err），"
                  . "且当前没有可用的 cf_clearance（回退 HTML 也会被 Cloudflare 挑战）。处理方式："
                  . "1) 等 1 分钟后重试；2) 插件设置页填 nhentai API Key（额度 45 次/分钟）；"
                  . "3) 调大 NHENTAI_API_MAX_WAIT（如 120）让插件自动等待限流窗口；"
                  . "4) 批量打标签时加大 NHENTAI_API_MIN_INTERVAL（如 5）。\n";
            }
        } else {
            $logger->warn("v2 API 不可用（$err），回退 HTML DOM");
        }
    }

    # ---- (B) HTML DOM 回退 ----
    $logger->info("Fetching HTML DOM to extract tags (API fallback)...");
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

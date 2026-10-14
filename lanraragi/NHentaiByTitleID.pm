package LRR::Plugin::Metadata::NHentaiByTitleID;

# ==========================================================
# nHentai 元数据插件（单文件版 · 三级回退识别）
#
# 逻辑：
#   1. 优先识别压缩包名称末端的 [id]（也支持 【id】/(id)），按 ID 抓取元数据；
#   2. 没有 [id] 时，按压缩包名称搜索抓取元数据；
#   3. 有 [id] 但按 ID 抓不到时，去掉 [id] 后按剩余名称搜索抓取。
#
# 识别规则与 nHentai 下载服务的文件夹命名一致：「本子名 [本子id]」。
#
# 本文件完全自包含（单个 .pm，无任何附属文件）：
#   - 在 LANraragi 内运行：自动使用官方日志模块；
#   - 脱离 LANraragi 运行：自动降级为内置简易日志；
#   - 自检：直接执行  perl NHentaiByTitleID.pm  （内置 mock，19 项断言）
# ==========================================================

use strict;
use warnings;
no warnings 'uninitialized';
use utf8;

use Encode qw(encode_utf8);

# 日志：优先 LANraragi 官方 logger，缺失时降级为内置 logger
sub _logger {
    my $use_lrr = eval { require LANraragi::Utils::Logging; 1 } ? 1 : 0;
    if ( $use_lrr && defined &LANraragi::Utils::Logging::get_plugin_logger ) {
        return LANraragi::Utils::Logging::get_plugin_logger();
    }
    return LRR::Plugin::Metadata::NHentaiByTitleID::SelfLogger->new();
}

sub plugin_info {
    return (
        name        => "nHentai [ID]/名称 三级回退",
        type        => "metadata",
        namespace   => "nhtitleid",
        description => "优先识别压缩包名末端的 [id] 按 ID 抓取 nHentai 元数据；"
                     . "无 [id] 则按名称搜索；有 [id] 但抓不到则去掉 [id] 后按名称搜索。",
        author      => "Paccu",
        version     => "1.1.0",
        oneshot_arg => "可填本子 ID、本子 URL 或搜索关键词（留空则自动识别）",
        parameters  => {
            'addSourceTag'        => { type => "bool", desc => "附加 source: 来源链接标签",        default_value => "1" },
            'preferJapaneseTitle' => { type => "bool", desc => "优先使用日文标题（若存在）",        default_value => "0" }
        }
    );
}

# ==========================================================
# 入口
# ==========================================================
sub get_tags {
    shift;
    my ( $lrr_info, $params ) = @_;
    my $logger = _logger();

    # 压缩包名称（去掉扩展名）
    my $raw_title = $lrr_info->{archive_title} // '';
    if ( $raw_title eq '' && $lrr_info->{file_path} ) {
        ($raw_title = $lrr_info->{file_path}) =~ s{^.*[\\/]}{};
    }
    ( my $base = $raw_title ) =~ s/\.(zip|rar|7z|cbz|cbr|tar|gz|tgz|lzma|tar\.gz)$//i;
    $base =~ s/^\s+|\s+$//g;

    my $oneshot = $lrr_info->{oneshot_param} // '';
    my ( $gallery, $source );

    if ( $oneshot ne '' ) {
        # 一次性参数：URL / 纯 ID / 搜索关键词
        if ( $oneshot =~ m{(?:nhentai\.net/g/|^)(\d{3,9})/?\s*$} ) {
            my $id = $1;
            $logger->info("一次性参数指定本子 ID: $id");
            $gallery = _fetch_gallery( $lrr_info, $id, $logger );
            $source  = "https://nhentai.net/g/$id/";
            if ( !$gallery ) {
                $logger->warn("按 ID $id 抓取失败，改用一次性参数作为搜索词");
                ( $gallery, $source ) = _search_by_name( $lrr_info, $oneshot, $logger );
            }
        } else {
            $logger->info("一次性参数作为搜索关键词: $oneshot");
            ( $gallery, $source ) = _search_by_name( $lrr_info, $oneshot, $logger );
        }

    } elsif ( my $id = _extract_trailing_id($base) ) {
        # ① 末端 [id] -> 按 ID 抓取
        $logger->info("识别到压缩包末端 [id] = $id，按 ID 抓取元数据");
        $gallery = _fetch_gallery( $lrr_info, $id, $logger );
        $source  = "https://nhentai.net/g/$id/";

        # ③ 有 [id] 但抓不到 -> 去掉 [id] 后按名称抓取
        if ( !$gallery ) {
            my $clean = _strip_trailing_id($base);
            $logger->warn("按 ID $id 抓取失败，改用去掉 [id] 的名称搜索: $clean");
            ( $gallery, $source ) = _search_by_name( $lrr_info, $clean, $logger );
        }

    } else {
        # ② 无 [id] -> 按压缩包名称抓取
        $logger->info("压缩包名未含末端 [id]，按名称抓取元数据: $base");
        ( $gallery, $source ) = _search_by_name( $lrr_info, $base, $logger );
    }

    die "无法获取元数据（按 ID 与名称均未命中）\n"
      unless $gallery && ( $gallery->{title} || @{ $gallery->{tags} || [] } );

    my $tags = join( ', ', @{ $gallery->{tags} || [] } );
    if ( ( $params->{addSourceTag} // 1 ) && $source ) {
        $tags .= ( $tags ne '' ? ', ' : '' ) . "source:$source";
    }

    my $newtitle = ( $params->{preferJapaneseTitle} && $gallery->{title_ja} )
        ? $gallery->{title_ja}
        : $gallery->{title};

    $logger->info("元数据抓取成功: $newtitle");
    return ( tags => $tags, title => $newtitle );
}

# ==========================================================
# 名称解析
# ==========================================================

# 识别名称末端的 [id] / 【id】/ (id)
sub _extract_trailing_id {
    my ($name) = @_;
    return unless defined $name && $name ne '';
    if ( $name =~ /[\[\(【]\s*(\d{3,9})\s*[\]\)】]\s*$/ ) {
        return $1;
    }
    return;
}

# 去掉名称末端的 [id]
sub _strip_trailing_id {
    my ($name) = @_;
    return '' unless defined $name;
    $name =~ s/\s*[\[\(【]\s*\d{3,9}\s*[\]\)】]\s*$//;
    $name =~ s/\s+$//;
    return $name;
}

sub _urlencode {
    my ($s) = @_;
    my $bytes = encode_utf8( $s // '' );
    $bytes =~ s/([^A-Za-z0-9\-_.~])/sprintf("%%%02X", ord($1))/ge;
    return $bytes;
}

# ==========================================================
# 抓取与解析
# ==========================================================

sub _http_get {
    my ( $lrr_info, $url, $logger ) = @_;
    my $ua  = $lrr_info->{user_agent};
    my $res = $ua->get(
        $url => {
            'User-Agent' =>
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Referer' => 'https://nhentai.net/',
            'Accept'  => 'text/html,application/xhtml+xml,*/*;q=0.8'
        }
    )->result;

    if ( !$res->is_success ) {
        $logger->warn("请求失败 $url : HTTP " . $res->code);
        return;
    }
    return $res->body;
}

# 按 ID 抓取本子页面并解析；失败返回 undef
sub _fetch_gallery {
    my ( $lrr_info, $id, $logger ) = @_;
    my $html = _http_get( $lrr_info, "https://nhentai.net/g/$id/", $logger );
    return unless defined $html;
    return _parse_gallery_page($html);
}

# 按名称搜索，取第一个结果再抓取；返回 ($gallery, $source)
sub _search_by_name {
    my ( $lrr_info, $name, $logger ) = @_;
    $name =~ s/^\s+|\s+$//g if defined $name;
    return ( undef, undef ) unless defined $name && $name ne '';

    my $html = _http_get( $lrr_info, 'https://nhentai.net/search/?q=' . _urlencode($name), $logger );
    return ( undef, undef ) unless defined $html;

    my ($id) = $html =~ m{/g/(\d+)/};
    unless ($id) {
        $logger->warn("按名称未搜索到结果: $name");
        return ( undef, undef );
    }
    $logger->info("按名称 \"$name\" 命中本子 ID: $id");

    my $gallery = _fetch_gallery( $lrr_info, $id, $logger );
    return ( $gallery, "https://nhentai.net/g/$id/" );
}

# 解析本子页面：标题 + 带命名空间的标签
sub _parse_gallery_page {
    my ($html) = @_;

    my ($title) = $html =~ m{<h1[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>(.*?)</h1>}s;
    ($title) = $html =~ m{<h2[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>(.*?)</h2>}s unless defined $title;
    $title = _strip_html($title) if defined $title;

    my ($title_ja) = $html =~ /"japanese"\s*:\s*"((?:[^"\\]|\\.)*)"/;
    $title_ja = _unescape_json($title_ja) if defined $title_ja;

    my @tags;
    while ( $html =~
        m{<a[^>]+href="/(tag|artist|group|parody|character|language|category)/[^"]*"[^>]*>(.*?)</a>}gs )
    {
        my ( $type, $inner ) = ( $1, $2 );
        my ($name) = $inner =~ m{<span[^>]*class="[^"]*\bname\b[^"]*"[^>]*>(.*?)</span>}s;
        next unless defined $name;
        $name = _strip_html($name);
        next if $name eq '';
        push @tags, "$type:$name";
    }

    return unless defined $title || @tags;
    return { title => $title, title_ja => $title_ja, tags => \@tags };
}

sub _strip_html {
    my ($s) = @_;
    return '' unless defined $s;
    $s =~ s/<[^>]+>/ /g;
    $s =~ s/&amp;/&/g;
    $s =~ s/&lt;/</g;
    $s =~ s/&gt;/>/g;
    $s =~ s/&quot;/"/g;
    $s =~ s/&#39;/'/g;
    $s =~ s/&nbsp;/ /g;
    $s =~ s/\s+/ /g;
    $s =~ s/^\s+|\s+$//g;
    return $s;
}

sub _unescape_json {
    my ($s) = @_;
    return '' unless defined $s;
    $s =~ s/\\u([0-9a-fA-F]{4})/chr(hex($1))/ge;
    $s =~ s/\\n/ /g;
    $s =~ s/\\"/"/g;
    $s =~ s/\\\\/\\/g;
    return $s;
}

# ==========================================================
# 内置简易日志器（脱离 LANraragi 运行时降级使用）
# ==========================================================
package LRR::Plugin::Metadata::NHentaiByTitleID::SelfLogger;

sub new { bless {}, shift }
sub info  { print STDERR "  [info] $_[1]\n" }
sub warn  { print STDERR "  [warn] $_[1]\n" }
sub error { print STDERR "  [error] $_[1]\n" }
sub debug { }

# ==========================================================
# 自检用 mock（仅 perl NHentaiByTitleID.pm 直接运行时使用）
# ==========================================================
package LRR::Plugin::Metadata::NHentaiByTitleID::MockRes;

sub new { my ( $c, $body ) = @_; bless { body => $body }, $c }
sub is_success { defined $_[0]{body} }
sub body       { $_[0]{body} }
sub code       { defined $_[0]{body} ? 200 : 404 }

package LRR::Plugin::Metadata::NHentaiByTitleID::MockTx;

sub new    { my ( $c, $body ) = @_; bless { body => $body }, $c }
sub result { LRR::Plugin::Metadata::NHentaiByTitleID::MockRes->new( $_[0]{body} ) }

package LRR::Plugin::Metadata::NHentaiByTitleID::MockUA;

sub new { my ( $c, %routes ) = @_; bless { routes => \%routes }, $c }
sub get {
    my ( $self, $url ) = @_;
    return LRR::Plugin::Metadata::NHentaiByTitleID::MockTx->new( $self->{routes}{$url} );
}

# ==========================================================
# 回到主包：内置自检（perl NHentaiByTitleID.pm 直接运行触发）
# ==========================================================
package LRR::Plugin::Metadata::NHentaiByTitleID;

sub run_selftest {
    binmode STDOUT, ':encoding(UTF-8)';
    binmode STDERR, ':encoding(UTF-8)';

    my $GALLERY_HTML = <<'HTML';
<html><body>
<div id="info"><h1 class="title">[AuthorA] Sample Gallery Title</h1></div>
<div class="tag-container"><a class="tag" href="/artist/authora/"><span class="name">authora</span></a></div>
<div class="tag-container"><a class="tag" href="/tag/female/"><span class="name">female</span></a></div>
<div class="tag-container"><a class="tag" href="/language/chinese/"><span class="name">chinese</span></a></div>
<script>window._gallery = {"media_id":"9","num_pages":3,"japanese":"日本語のタイトル","pages":[{"t":"j"}]};</script>
</body></html>
HTML

    my $SEARCH_HTML = '<html><body><a href="/g/777/"><img src="x"></a></body></html>';

    my $PASS = 0;
    my $FAIL = 0;
    my $ok   = sub {
        my ( $cond, $name ) = @_;
        if ($cond) { $PASS++; print "  ok   - $name\n"; }
        else       { $FAIL++; print "  FAIL - $name\n"; }
    };

    my $call = sub {
        my ( $title, $routes, $oneshot, $params ) = @_;
        my $lrr_info = {
            archive_title => $title,
            oneshot_param => $oneshot,
            user_agent    => LRR::Plugin::Metadata::NHentaiByTitleID::MockUA->new(%$routes)
        };
        $params ||= { addSourceTag => 1, preferJapaneseTitle => 0 };
        return get_tags( undef, $lrr_info, $params );
    };

    my $extract = \&_extract_trailing_id;
    my $strip   = \&_strip_trailing_id;
    my $enc     = \&_urlencode;

    print "== 1. 末端 [id] 识别 ==\n";
    $ok->( $extract->('[AuthorA] Title [123456]') eq '123456', 'ASCII [id]' );
    $ok->( $extract->('Title 【123456】')          eq '123456', '全角【id】' );
    $ok->( $extract->('Title (123456)')            eq '123456', '圆括号 (id)' );
    $ok->( !defined $extract->('Title [123456] extra'), '非末端不识别' );
    $ok->( !defined $extract->('No id here'),            '无 id' );
    $ok->( $strip->('[AuthorA] Title [123456]') eq '[AuthorA] Title', '去尾 [id]' );

    print "== 2. (1) 有 [id] -> 按 ID 抓取 ==\n";
    {
        my %r = $call->(
            '[AuthorA] Sample Gallery Title [123456]',
            { 'https://nhentai.net/g/123456/' => $GALLERY_HTML }
        );
        $ok->( $r{title} eq '[AuthorA] Sample Gallery Title', '标题解析' );
        $ok->( $r{tags} =~ /artist:authora/,                  'artist 标签' );
        $ok->( $r{tags} =~ /tag:female/,                      'tag 标签' );
        $ok->( $r{tags} =~ /language:chinese/,                'language 标签' );
        $ok->( $r{tags} =~ m{source:https://nhentai\.net/g/123456/}, 'source 标签指向 ID 页' );
    }

    print "== 3. (2) 无 [id] -> 按名称搜索 ==\n";
    {
        my $name = '无ID的本子';
        my %r = $call->(
            $name,
            {
                'https://nhentai.net/search/?q=' . $enc->($name) => $SEARCH_HTML,
                'https://nhentai.net/g/777/' => $GALLERY_HTML
            }
        );
        $ok->( $r{title} eq '[AuthorA] Sample Gallery Title',     '搜索命中的标题' );
        $ok->( $r{tags} =~ m{source:https://nhentai\.net/g/777/}, 'source 指向搜索命中 ID' );
    }

    print "== 4. (3) 有 [id] 但抓不到 -> 去掉 [id] 按名称搜索 ==\n";
    {
        my $clean = '[AuthorA] Sample Gallery Title';
        my %r = $call->(
            '[AuthorA] Sample Gallery Title [999999]',
            {
                'https://nhentai.net/g/999999/' => undef,    # 按 ID 抓取失败(404)
                'https://nhentai.net/search/?q=' . $enc->($clean) => $SEARCH_HTML,
                'https://nhentai.net/g/777/' => $GALLERY_HTML
            }
        );
        $ok->( $r{title} eq '[AuthorA] Sample Gallery Title',     '回退搜索的标题' );
        $ok->( $r{tags} =~ m{source:https://nhentai\.net/g/777/}, '回退搜索命中' );
    }

    print "== 5. 一次性参数 ==\n";
    {
        my %r = $call->( '随便的压缩包名', { 'https://nhentai.net/g/555/' => $GALLERY_HTML }, 'https://nhentai.net/g/555/' );
        $ok->( $r{title} eq '[AuthorA] Sample Gallery Title', 'oneshot 指定 URL/ID' );
    }

    print "== 6. 日文标题优先 / source 开关 ==\n";
    {
        my %r = $call->(
            '[AuthorA] Sample Gallery Title [123456]',
            { 'https://nhentai.net/g/123456/' => $GALLERY_HTML },
            undef,
            { addSourceTag => 0, preferJapaneseTitle => 1 }
        );
        $ok->( $r{title} eq '日本語のタイトル', 'preferJapaneseTitle' );
        $ok->( $r{tags} !~ /source:/,           'addSourceTag=0 不加 source' );
    }

    print "== 7. 全部失败 -> die ==\n";
    {
        my $died = 0;
        eval { $call->( '未知本子 [404404]', {} ); } or $died = 1;
        $ok->( $died, 'ID 与名称都失败时抛出异常' );
    }

    print "------------------------------------------\n";
    print "  通过 $PASS，失败 $FAIL\n";
    return ( $FAIL > 0 ? 1 : 0 );
}

# 直接执行本文件 => 运行内置自检；
# 被 LANraragi require 加载（caller 非空）=> 不执行。
unless (caller) {
    exit run_selftest();
}

1;
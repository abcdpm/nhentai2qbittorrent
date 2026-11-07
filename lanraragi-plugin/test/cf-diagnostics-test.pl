#!/usr/bin/perl
# ---------------------------------------------------------------------------
# nHentaiCustom.pm 无依赖自检（不需要安装 Mojo / LANraragi）
#   perl lanraragi-plugin/test/cf-diagnostics-test.pl
#
# 覆盖：Cloudflare 挑战页识别、浏览器化请求头、_nh_get 重试与详细报错。
# ---------------------------------------------------------------------------
use strict;
use warnings;
use utf8;
use FindBin;
binmode( STDOUT, ':encoding(UTF-8)' );

BEGIN {
    # 用假模块占位，让插件在无 LRR / Mojo 环境下也能被 require
    $INC{'Mojo/UserAgent.pm'}          = __FILE__;
    $INC{'Mojo/DOM.pm'}                = __FILE__;
    $INC{'LANraragi/Model/Plugins.pm'} = __FILE__;
    $INC{'LANraragi/Utils/Logging.pm'} = __FILE__;
    $INC{'LANraragi/Utils/Redis.pm'}   = __FILE__;
    $INC{'URI/Escape.pm'}              = __FILE__;
    $INC{'Mojo/JSON.pm'}               = __FILE__;

    # 测试里不要真的 sleep
    *CORE::GLOBAL::sleep = sub { 0 };
}

package Mojo::UserAgent;                sub new { bless {}, shift } sub import { } 1;
package Mojo::DOM;                      sub import { } 1;
package LANraragi::Model::Plugins;      sub import { } 1;
package URI::Escape;                    use Exporter qw(import); our @EXPORT_OK = qw(uri_escape_utf8 uri_escape);
                                        sub uri_escape_utf8 { $_[0] } sub uri_escape { $_[0] } 1;
package Mojo::JSON;                     use Exporter qw(import); our @EXPORT_OK = qw(decode_json encode_json);
                                        sub decode_json { require JSON::PP; JSON::PP::decode_json( $_[0] ) }
                                        sub encode_json { require JSON::PP; JSON::PP::encode_json( $_[0] ) } 1;
package LANraragi::Utils::Redis;        use Exporter qw(import); our @EXPORT_OK = qw(redis_decode); sub redis_decode { $_[0] } 1;

package TestLogger;
sub new  { bless { log => [] }, shift }
sub info { push @{ $_[0]{log} }, [ 'info', $_[1] ] }
sub warn { push @{ $_[0]{log} }, [ 'warn', $_[1] ] }
sub log  { $_[0]{log} }

package LANraragi::Utils::Logging;
use Exporter qw(import);
our @EXPORT_OK = qw(get_plugin_logger);
our $LOGGER;
sub get_plugin_logger { $LOGGER ||= TestLogger->new }

package FakeHeaders;
sub new { bless { h => {} }, shift }
sub header {
    my $s = shift;
    return $s->{h}{ lc $_[0] } if @_ == 1;
    while ( my ( $k, $v ) = splice( @_, 0, 2 ) ) { $s->{h}{ lc $k } = $v }
    return;
}

package FakeCookie;
sub new  { my ( $c, $n ) = @_; bless { name => $n }, $c }
sub name { $_[0]{name} }

package FakeJar;
sub new { my ( $c, @n ) = @_; bless { list => [ map { FakeCookie->new($_) } @n ] }, $c }
sub all { @{ $_[0]{list} } }

package FakeRes;
sub new { my ( $c, %a ) = @_; bless { %a }, $c }
sub code     { $_[0]{code} // 0 }
sub body     { $_[0]{body} // '' }
sub headers  { $_[0]{headers} ||= FakeHeaders->new }
sub is_error { my $c = $_[0]->code; $c >= 400 ? 1 : 0 }

package FakeTX;
sub new     { my ( $c, %a ) = @_; bless { %a, headers => FakeHeaders->new }, $c }
sub req     { $_[0] }
sub headers { $_[0]{headers} }
sub result  { $_[0]{res} }

package FakeTrans;
sub new  { bless { name => $_[1] }, $_[0] }
sub name { $_[0]{name} }

package FakeUA;
sub new { my ( $c, %a ) = @_; bless { %a, n => 0 }, $c }
sub transactor         { FakeTrans->new( $_[0]{ua_name} // '' ) }
sub cookie_jar         { FakeJar->new( @{ $_[0]{cookies} || [] } ) }
sub http_headers       { FakeHeaders->new }
sub inactivity_timeout { }
sub max_redirects     { }
sub build_tx           { FakeTX->new( req_headers => FakeHeaders->new ) }
sub start {
    my ( $s, $tx ) = @_;
    $tx->{res} = $s->{responses}[ $s->{n}++ ] || FakeRes->new( code => 200, body => 'ok' );
    $s->{last_tx} = $tx;
    return $tx;
}


our @FAILS;
sub ok {
    my ( $cond, $name ) = @_;
    print( $cond ? "ok   - $name\n" : "FAIL - $name\n" );
    push @FAILS, $name unless $cond;
}

require "$FindBin::Bin/../nHentaiCustom.pm";

my $pkg = 'LANraragi::Plugin::Metadata::nHentaiCustom';
no strict 'refs';
my $headers_sub   = \&{"${pkg}::_browser_headers"};
my $challenge_sub = \&{"${pkg}::_is_challenge_page"};
my $nh_get_sub    = \&{"${pkg}::_nh_get"};
my $diag_sub      = \&{"${pkg}::_request_diag"};

# ---- 1. 浏览器化请求头：与 UA 一致 ----
my $ua = FakeUA->new(
    ua_name => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
);
my $h = $headers_sub->($ua);
ok( $h->{'sec-ch-ua'} =~ /"Google Chrome";v="148"/, 'sec-ch-ua 与 UA 的 Chrome 版本一致' );
ok( $h->{'sec-ch-ua-platform'} eq '"Windows"',        'sec-ch-ua-platform 与 UA 的平台一致' );
ok( $h->{'Referer'} eq 'https://nhentai.net/',        '默认 Referer 指向站点根' );
ok( $h->{'Accept'} =~ m{text/html},                   'Accept 为浏览器文档请求值' );

# ---- 2. 挑战页识别 ----
my $res403 = FakeRes->new( code => 403, body => '<html><head><title>Just a moment...</title></head></html>' );
ok( $challenge_sub->( $res403, $res403->body ) =~ /Just a moment/, '403 挑战页可识别' );

my $res403b = FakeRes->new( code => 403, body => '<html>Use new API https://nhentai.net/api/v2/docs</html>' );
ok( $challenge_sub->( $res403b, $res403b->body ) eq '', '普通 403 不被误判为挑战页' );

my $res404 = FakeRes->new( code => 404, body => '{"error":"Not Found"}' );
ok( $challenge_sub->( $res404, $res404->body ) eq '', '404 不被误判为挑战页' );

my $resMitigated = FakeRes->new( code => 200, body => 'x' );
$resMitigated->headers->header( 'cf-mitigated' => 'challenge' );
ok( $challenge_sub->( $resMitigated, 'x' ) =~ /cf-mitigated/, 'cf-mitigated: challenge 响应头可识别' );

# ---- 3. _nh_get 重试：先挑战后成功 ----
my $ua2 = FakeUA->new(
    ua_name   => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0 Safari/537.36',
    responses => [
        FakeRes->new( code => 403, body => '<title>Just a moment...</title>' ),
        FakeRes->new( code => 200, body => '<div class="tag-container"></div>' ),
    ]
);
my $got = eval { $nh_get_sub->( $ua2, 'https://nhentai.net/g/1/', 'test' ) };
ok( $got && $got->code == 200, '首次挑战 → 重试后成功返回 200' );
ok( $ua2->{n} == 2, '确实重试了一次' );

# ---- 4. _nh_get 连续挑战：报错信息包含排查清单 ----
my $ua3 = FakeUA->new(
    ua_name   => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0 Safari/537.36',
    responses => [ map { FakeRes->new( code => 403, body => '<title>Just a moment...</title>' ) } 1 .. 3 ]
);
my $err = '';
eval { $nh_get_sub->( $ua3, 'https://nhentai.net/g/1/', 'test' ); 1 } or $err = $@;
ok( $err =~ /Cloudflare 挑战页拦截/, '连续挑战时报错明确指出 Cloudflare 挑战页' );
ok( $err =~ /cf_clearance/,         '报错包含 cf_clearance 排查项' );
ok( $err =~ /出口 IP/,              '报错包含出口 IP 排查项' );
ok( $err =~ /NHENTAI_BASE_URL/,     '报错包含镜像/反代兜底提示' );

# ---- 5. 诊断信息：cookie 名称与 cf_clearance 有无 ----
my $ua4  = FakeUA->new( ua_name => 'UA-Test', cookies => [ 'cf_clearance', '__cf_bm' ] );
my $diag = $diag_sub->( $ua4, 'https://nhentai.net/g/1/' );
ok( $diag =~ /cf_clearance=有/, '诊断信息能识别 cf_clearance 是否存在' );
ok( $diag =~ /cookie 数=2/,     '诊断信息输出 cookie 数量' );

# ---- 6. 404 明确区分 ----
my $ua5    = FakeUA->new( responses => [ FakeRes->new( code => 404, body => 'nope' ) ] );
my $err404 = '';
eval { $nh_get_sub->( $ua5, 'https://nhentai.net/g/1/', 'test' ); 1 } or $err404 = $@;
ok( $err404 =~ /404/,   '404 单独报错（不重试、不当成挑战页）' );
ok( $ua5->{n} == 1,     '404 不会重试' );

# ---- 7. v2 API：JSON → tags/title 映射（命名空间规则与 HTML 路径一致） ----
$ENV{NHENTAI_API_MIN_INTERVAL} = 0;    # 自检不节流、不真等待
my $api_hashdata_sub = \&{"${pkg}::_api_hashdata"};
my $api_get_sub      = \&{"${pkg}::_nh_api_get"};
my $norm_sub         = \&{"${pkg}::_norm_title"};
my $get_tags_sub     = \&{"${pkg}::get_tags_from_NH"};
my $from_title_sub   = \&{"${pkg}::get_gallery_id_from_title"};

my $sample = {
    id        => 694315,
    media_id  => '4299500',
    num_pages => 14,
    title     => { english => 'EN title', japanese => 'JP title', pretty => 'Swimsuit Gigi sex' },
    tags      => [
        { type => 'category', name => 'doujinshi' },
        { type => 'language', name => 'chinese' },
        { type => 'tag',      name => 'sole male' },
        { type => 'artist',   name => 'falboij' },
        { type => 'parody',   name => 'vtuber' },
    ],
};
my %m = $api_hashdata_sub->( $sample, 694315, 1 );
ok( $m{tags} =~ /(?:^|, )sole male(?:, |$)/, 'API tag 类型不带命名空间前缀' );
ok( $m{tags} =~ /category:doujinshi/, 'API category 带命名空间' );
ok( $m{tags} =~ /language:chinese/,   'API language 带命名空间' );
ok( $m{tags} =~ /artist:falboij/,     'API artist 带命名空间' );
ok( $m{tags} =~ m{source:nhentai\.net/g/694315}, 'API 路径同样附带 source 标签' );
ok( $m{title} eq 'Swimsuit Gigi sex', 'save title 时取 pretty 标题' );

my %m2 = $api_hashdata_sub->( { tags => [ { type => 'tag', name => 'x' } ] }, 1, 0 );
ok( !exists $m2{title}, '未开启 save title 时不返回标题' );

# ---- 8. _nh_api_get：200 / 404 / 429 退避 ----
my $uaA = FakeUA->new( responses => [ FakeRes->new( code => 200, body => '{"id":1,"tags":[]}' ) ] );
my ( $jA, $eA ) = $api_get_sub->( $uaA, '/api/v2/galleries/1' );
ok( ref($jA) eq 'HASH' && $jA->{id} == 1, 'v2 API 200 JSON 正确解析' );
ok( $eA eq '', 'API 成功时无错误' );

my $uaB = FakeUA->new( responses => [ FakeRes->new( code => 404, body => '{"error":"Not Found"}' ) ] );
my ( $jB, $eB ) = $api_get_sub->( $uaB, '/api/v2/galleries/999' );
ok( !$jB && $eB eq 'not_found', 'v2 API 404 → not_found' );
ok( $uaB->{n} == 1, 'v2 API 404 不重试' );

my $res429 = FakeRes->new( code => 429, body => '{"error":"Rate limit exceeded"}' );
$res429->headers->header( 'retry-after' => '0' );
my $uaC = FakeUA->new(
    responses => [ $res429, FakeRes->new( code => 200, body => '{"id":2,"tags":[]}' ) ] );
my ( $jC, $eC ) = $api_get_sub->( $uaC, '/api/v2/galleries/2' );
ok( ref($jC) eq 'HASH' && $jC->{id} == 2, '429 后按 retry-after 退避重试成功' );
ok( $uaC->{n} == 2, '429 确实触发了一次重试' );

# ---- 9. get_tags_from_NH：API 优先，命中后不再抓 HTML ----
my $uaD = FakeUA->new(
    responses => [ FakeRes->new( code => 200, body => Mojo::JSON::encode_json($sample) ) ] );
my %apiTags = $get_tags_sub->( '694315', $uaD, 0 );
ok( $apiTags{tags} =~ /sole male/, 'get_tags_from_NH 通过 API 拿到标签' );
ok( $uaD->{n} == 1,                'API 命中时不再请求 HTML 页面' );

my $uaE = FakeUA->new( responses => [ FakeRes->new( code => 404, body => '{}' ) ] );
my $errE = '';
eval { $get_tags_sub->( '1', $uaE, 0 ); 1 } or $errE = $@;
ok( $errE =~ /Code: 404/, 'API 404 时明确报「本子不存在」' );

# ---- 10. API 被限流：有 cf_clearance 才回退 HTML；没有则直接报明确错误 ----
$ENV{NHENTAI_API_MAX_WAIT} = 0;    # retry-after 超过该值就立即放弃等待
my $res429b = FakeRes->new( code => 429, body => '{"error":"Rate limit exceeded"}' );
$res429b->headers->header( 'retry-after' => '60' );
my $uaF = FakeUA->new(
    cookies   => ['cf_clearance'],     # 握有 cf_clearance → 值得尝试 HTML
    responses => [
        $res429b,
        map { FakeRes->new( code => 403, body => '<title>Just a moment...</title>' ) } 1 .. 3
    ]
);
my $errF = '';
eval { $get_tags_sub->( '694315', $uaF, 0 ); 1 } or $errF = $@;
ok( $errF =~ /Cloudflare 挑战页拦截/, '限流 + 有 cf_clearance → 回退 HTML（被挑战则报 CF 诊断）' );
ok( $uaF->{n} >= 2, '确实发起过 HTML 请求' );

# 没有 cf_clearance 时不该白跑注定被挑战的 HTML：直接报可操作错误
my $res429c = FakeRes->new( code => 429, body => '{"error":"Rate limit exceeded"}' );
$res429c->headers->header( 'retry-after' => '60' );
my $uaL = FakeUA->new(
    responses => [ $res429c, FakeRes->new( code => 200, body => 'should not be used' ) ] );
my $errL = '';
eval { $get_tags_sub->( '694315', $uaL, 0 ); 1 } or $errL = $@;
ok( $errL =~ /v2 API 触发限流/, '无 cf_clearance 时限流直接报明确错误' );
ok( $errL =~ /API Key/,        '错误里给出「配置 API Key」的建议' );
ok( $uaL->{n} == 1,            '无 cf_clearance 时不会白跑 HTML 请求（只发了 1 次）' );
delete $ENV{NHENTAI_API_MAX_WAIT};

# ---- 11. 按标题搜索：v2 搜索优先 ----
my $searchJson = Mojo::JSON::encode_json(
    {   result => [
            { id => 693033, english_title => 'Other thing' },
            { id => 694315, english_title => 'Swimsuit Gigi sex' },
        ]
    }
);
my $uaG = FakeUA->new( responses => [ FakeRes->new( code => 200, body => $searchJson ) ] );
my $found = $from_title_sub->( 'Swimsuit Gigi sex', $uaG );
ok( defined $found && $found == 694315, 'v2 搜索优先选中标题归一化一致的候选' );

my $uaH = FakeUA->new( responses => [] );
ok( $from_title_sub->( 'Foo {123456}', $uaH ) == 123456, '{id} 语法直接取 id' );
ok( $uaH->{n} == 0, '{id} 语法不发起任何请求' );

# ---- 12. 标题归一化 ----
ok( $norm_sub->('A [B] c!') eq 'abc', '_norm_title 忽略大小写/标点/空白' );

# ---- 13. API Key：插件参数（custom_args[1]）优先于环境变量 ----
$ENV{NHENTAI_API_KEY} = 'env-key';
${"${pkg}::NH_API_KEY"} = '';
my $uaI = FakeUA->new(
    responses => [ FakeRes->new( code => 200, body => Mojo::JSON::encode_json($sample) ) ] );
my %resI = $pkg->get_tags(
    {   custom_args    => [ 0, 'param-key' ],
        oneshot_param  => 'https://nhentai.net/g/694315/',
        archive_title  => 'dummy',
        existing_tags  => '',
        user_agent     => $uaI,
    }
);
my $auth = $uaI->{last_tx} ? ( $uaI->{last_tx}->headers->header('Authorization') // '' ) : '';
ok( $auth eq 'Key param-key', '插件设置页填的 API Key 会作为 Authorization 头发送（优先于环境变量）' );
ok( $resI{tags} =~ /sole male/, '通过 get_tags 走 API 路径返回标签' );

${"${pkg}::NH_API_KEY"} = '';
my $uaJ = FakeUA->new(
    responses => [ FakeRes->new( code => 200, body => Mojo::JSON::encode_json($sample) ) ] );
$api_get_sub->( $uaJ, '/api/v2/galleries/1' );
ok( ( $uaJ->{last_tx}->headers->header('Authorization') // '' ) eq 'Key env-key',
    '插件参数为空时回落到环境变量 NHENTAI_API_KEY' );

delete $ENV{NHENTAI_API_KEY};
my $uaK = FakeUA->new(
    responses => [ FakeRes->new( code => 200, body => Mojo::JSON::encode_json($sample) ) ] );
$api_get_sub->( $uaK, '/api/v2/galleries/1' );
ok( !defined $uaK->{last_tx}->headers->header('Authorization'), '都没配置时不发送 Authorization 头' );

# ---- 14. 节流间隔：显式设置优先；否则按是否带 API Key 自动放宽 ----
my $interval_sub = \&{"${pkg}::_nh_api_min_interval"};
ok( $interval_sub->() == 0, '显式 NHENTAI_API_MIN_INTERVAL=0 时以显式值为准（0=不节流）' );

delete $ENV{NHENTAI_API_MIN_INTERVAL};
delete $ENV{NHENTAI_API_KEY};
${"${pkg}::NH_API_KEY"} = 'param-key';
ok( $interval_sub->() == 1.5, '配了 API Key 时节流自动放宽到 1.5s（≈40 次/分钟）' );

${"${pkg}::NH_API_KEY"} = '';
ok( $interval_sub->() == 3.2, '没有 API Key 时保持 3.2s（20 次/分钟）' );

# ---- 15. 诊断：空名 Cookie 会被提示为 login 插件注入格式问题 ----
my $uaM   = FakeUA->new( ua_name => 'UA', cookies => [ '', 'cf_clearance' ] );
my $diagM = $diag_sub->( $uaM, 'https://nhentai.net/g/1/' );
ok( $diagM =~ /空名 Cookie/, '空名 Cookie 时诊断提示 CF Bypass 注入格式问题' );

print "\n" . ( @FAILS ? '失败 ' . scalar(@FAILS) . " 项\n" : "全部通过\n" );
exit( @FAILS ? 1 : 0 );

package main;

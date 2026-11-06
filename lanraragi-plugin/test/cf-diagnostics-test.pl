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

    # 测试里不要真的 sleep
    *CORE::GLOBAL::sleep = sub { 0 };
}

package Mojo::UserAgent;                sub new { bless {}, shift } sub import { } 1;
package Mojo::DOM;                      sub import { } 1;
package LANraragi::Model::Plugins;      sub import { } 1;
package URI::Escape;                    sub import { } sub uri_escape_utf8 { $_[0] } 1;
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
sub build_tx           { FakeTX->new( req_headers => FakeHeaders->new ) }
sub start {
    my ( $s, $tx ) = @_;
    $tx->{res} = $s->{responses}[ $s->{n}++ ] || FakeRes->new( code => 200, body => 'ok' );
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

print "\n" . ( @FAILS ? '失败 ' . scalar(@FAILS) . " 项\n" : "全部通过\n" );
exit( @FAILS ? 1 : 0 );

package main;

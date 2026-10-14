package LANraragi::Plugin::Metadata::NHentaiByTitleID;

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
        name        => "nHentai (Custom Fixed + [ID] Fallback)",
        type        => "metadata",
        namespace   => "nhtitleid",
        login_from  => "nhcustomcf",
        author      => "Difegue, Fixed by Paccu",
        version     => "2.16 ([ID] Fallback)",
        description => "Extracts tags strictly from HTML DOM to avoid strict 429 rate limits on V2 API. Supports community tags. "
                     . "ID resolution: trailing [id] -> title search -> title without [id].",
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
        if ($fromID) {
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

sub get_gallery_dom_by_title {
    my ( $title, $ua ) = @_;
    my $logger = get_plugin_logger();

    $title =~ s/-|'/ /g;
    my $query = uri_escape_utf8($title);
    $query =~ s/%20/+/g;

    my $URL = "https://nhentai.net/search?q=" . $query;
    $logger->info("[DEBUG] Requesting URL: $URL");

    $ua = Mojo::UserAgent->new unless $ua;
    $ua->max_redirects(5);
    my $res = $ua->get($URL)->result;

    if ( $res->is_error ) { return; }
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
    my $URL = "https://nhentai.net/g/$gID/";
    
    $ua = Mojo::UserAgent->new unless $ua;
    $ua->max_redirects(5);
    my $res = $ua->get($URL)->result;

    if ( $res->is_error ) {
        my $code = $res->code;
        die "Error retrieving gallery from nHentai! (Code: $code)\n";
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

        # 使用通用的 a 标签匹配，可以同时抓出官方的 .tag 和社区版本的 .tagchip 容器
        for my $a ($dom->find('.tag-container a')->each) {
            my $href = $a->attr('href') // '';
            my $name_node = $a->at('.name');
            
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

        push( @tags, "source:nhentai.net/g/$gID" ) if ( @tags > 0 );
        $hashdata{tags} = join( ', ', @tags );

        if ($savetitle) {
            my $title_node = $dom->at('#info h2 .pretty') || $dom->at('#info h1 .pretty');
            if ($title_node) {
                $hashdata{title} = $title_node->all_text;
            }
        }
    }
    
    return %hashdata;
}

1;

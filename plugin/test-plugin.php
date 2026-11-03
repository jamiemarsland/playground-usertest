<?php
/**
 * The plugin against enough of WordPress to be worth testing: does it read the
 * option setSiteOptions leaves, does it tidy what a blueprint gives it, and is
 * it really inert on a site that is not a test?
 *
 * Run: php test-plugin.php
 *
 * Each case runs in its own process, because pgut_test() caches in a static and
 * the point of some of these is what happens on a first read.
 *
 * @package PlaygroundUserTest
 */

$fails = 0;

/**
 * Run one case in a fresh process and report what it printed.
 *
 * @param string $name Case name.
 * @param string $setup PHP that sets $GLOBALS['opts'] and then runs assertions.
 * @return void
 */
function case_run( $name, $setup ) {
	global $fails;
	$stubs = <<<'STUBS'
define( 'ABSPATH', true );
function get_option( $k, $d = false ) { return array_key_exists( $k, $GLOBALS['opts'] ) ? $GLOBALS['opts'][ $k ] : $d; }
function update_option( $k, $v, $a = null ) { $GLOBALS['opts'][ $k ] = $v; return true; }
function add_action() {}
function is_user_logged_in() { return true; }
function current_user_can() { return true; }
function wp_enqueue_script() { $GLOBALS['enqueued'] = true; }
function wp_localize_script( $h, $n, $d ) { $GLOBALS['loc'] = $d; }
function plugins_url( $f, $b ) { return 'http://example.test/' . $f; }
function sanitize_text_field( $s ) { return trim( strip_tags( (string) $s ) ); }
function esc_url_raw( $u ) { return $u; }
function rest_url( $p = '' ) { return 'http://example.test/wp-json/' . $p; }
function home_url( $p = '' ) { return 'http://example.test' . $p; }
function wp_create_nonce( $a ) { return 'nonce'; }
function wp_generate_password( $l, $s ) { return substr( str_shuffle( str_repeat( 'abcdefghijklmnopqrstuvwxyz0123456789', 3 ) ), 0, $l ); }
function get_current_user_id() { return 1; }
function get_user_meta( $u, $k, $s ) { return isset( $GLOBALS['umeta'][ $k ] ) ? $GLOBALS['umeta'][ $k ] : ''; }
function update_user_meta( $u, $k, $v ) { $GLOBALS['umeta'][ $k ] = $v; return true; }
class PGUT_Fake_DB { public function get_blog_prefix() { return 'wp_'; } }
$GLOBALS['wpdb'] = new PGUT_Fake_DB();
function ok( $cond, $msg ) { echo $cond ? "ok   $msg\n" : "FAIL $msg\n"; }
STUBS;
	$code = $stubs . "\n" . $setup;
	$out  = shell_exec( 'php -r ' . escapeshellarg( $code ) . ' 2>&1' );
	echo $out;
	if ( false !== strpos( (string) $out, 'FAIL' ) ) {
		$fails++;
	}
}

$plugin = escapeshellarg( __DIR__ . '/playground-usertest.php' );
$plugin = str_replace( "'", '', $plugin );

case_run(
	'a real test',
	'$GLOBALS["opts"] = array( "playground_user_test" => json_encode( array(
		"test" => "abc123defg", "report" => "https://example.test/api/events", "subject" => "my theme",
		"tasks" => array(
			array( "id" => "1-NAME!", "title" => " Give the site your own name ", "hint" => "Settings" ),
			array( "title" => "no id here" ),
			array( "nonsense" => 1 ),
		),
	) ) );
	require "' . $plugin . '";
	$t = pgut_test();
	ok( $t && $t["test"] === "abc123defg", "a JSON string from setSiteOptions is read" );
	pgut_enqueue();
	$loc = $GLOBALS["loc"];
	ok( count( $loc["tasks"] ) === 2, "a task with no title is dropped" );
	ok( $loc["tasks"][0]["id"] === "1-name", "a task id is cleaned to safe characters" );
	ok( $loc["tasks"][0]["title"] === "Give the site your own name", "titles are trimmed" );
	ok( $loc["tasks"][1]["id"] === "task-2", "a task with no id of its own gets one" );
	ok( preg_match( "/^[a-z0-9]{8,32}$/", $loc["session"] ) === 1, "a session id is made and kept" );
	$before = $loc["session"];
	pgut_enqueue();
	ok( $GLOBALS["loc"]["session"] === $before, "the same session id comes back on the next page" );
	pgut_quiet_guides();
	ok( empty( $GLOBALS["umeta"] ), "a test leaves the editors’ welcome guides alone" );'
);

case_run(
	'a normal site',
	'$GLOBALS["opts"] = array();
	require "' . $plugin . '";
	pgut_enqueue();
	ok( empty( $GLOBALS["enqueued"] ), "on a site with no test, nothing is enqueued at all" );'
);

case_run(
	'a half-written option',
	'$GLOBALS["opts"] = array( "playground_user_test" => json_encode( array( "test" => "abc123defg" ) ) );
	require "' . $plugin . '";
	pgut_enqueue();
	ok( empty( $GLOBALS["enqueued"] ), "an option with no tasks and nowhere to report is ignored" );'
);

case_run(
	'the colours check',
	'$GLOBALS["opts"] = array();
	require "' . $plugin . '";
	ok( pgut_styles_content( "{\"version\":3,\"isGlobalStylesUserThemeJSON\":true}" ) === "", "the empty record opening the Site Editor makes is not a change" );
	ok( pgut_styles_content( "{\"version\":3,\"isGlobalStylesUserThemeJSON\":true,\"settings\":[],\"styles\":[]}" ) === "", "nor is one with empty settings and styles" );
	ok( pgut_styles_content( "{\"version\":3,\"isGlobalStylesUserThemeJSON\":true,\"styles\":{\"color\":{\"background\":\"#000\"}}}" ) !== "", "a saved colour is a change" );'
);

case_run(
	'the closing questions',
	'$GLOBALS["opts"] = array( "playground_user_test" => json_encode( array(
		"test" => "abc123defg", "report" => "https://example.test/api/events",
		"tasks" => array( array( "title" => "Try the settings" ) ),
		"questions" => array( "happy" => " How happy are you with the settings? ", "feel" => "", "nonsense" => "x" ),
	) ) );
	require "' . $plugin . '";
	pgut_enqueue();
	$q = (array) $GLOBALS["loc"]["questions"];
	ok( "How happy are you with the settings?" === $q["happy"], "a test can put a closing question its own way" );
	ok( ! isset( $q["feel"] ) && ! isset( $q["nonsense"] ), "an empty question or one the card does not ask is dropped" );
	$GLOBALS["opts"]["playground_user_test"] = json_encode( array( "test" => "abc123defg", "report" => "https://example.test/api/events", "tasks" => array( array( "title" => "x" ) ) ) );'
);

case_run(
	'a tour',
	'$GLOBALS["opts"] = array( "playground_user_test" => json_encode( array(
		"test" => "abc123defg", "report" => "https://example.test/api/events", "mode" => "tour",
		"button" => array( "label" => "Get the plugin", "url" => "https://wordpress.org/plugins/x/" ),
		"theme" => array( "accent" => "#6B3FA0", "ink" => "#ffffff", "text" => "javascript:x", "card" => "light" ),
		"tasks" => array(
			array( "id" => "1-a", "title" => "Add the block", "hint" => "Click +", "point" => "[aria-label=\"Add block\"] <b>", "check" => array( "type" => "block", "block" => "Open-Today/hours" ) ),
			array( "id" => "2-b", "title" => "Change it", "check" => array( "type" => "block_changed", "block" => "not a block name" ) ),
			array( "id" => "3-c", "title" => "Open the Site Editor", "check" => array( "type" => "page", "path" => "site-editor.php?p=%2Fpage<b>" ),
				"do" => array( array( "click" => "button \"Styles\"" ), array( "type" => "styles", "into" => "input" ), array( "key" => "Escape" ), array( "key" => "Delete" ), array( "go" => "javascript:alert(1)" ), array( "go" => "/wp-admin/site-editor.php" ), array( "wait" => 99 ), array( "click" => "x", "maybe" => 1 ) ) ),
		),
	) ) );
	require "' . $plugin . '";
	pgut_enqueue();
	$loc = $GLOBALS["loc"];
	ok( "tour" === $loc["mode"], "a tour says so to the card" );
	ok( "Get the plugin" === $loc["button"]["label"] && "https://wordpress.org/plugins/x/" === $loc["button"]["url"], "and passes on the button it ends with" );
	ok( "[aria-label=\"Add block\"]" === $loc["tasks"][0]["point"], "a step keeps its selector, with any markup stripped: " . $loc["tasks"][0]["point"] );
	ok( "open-today/hours" === $loc["tasks"][0]["check"]["block"], "a block check keeps its block name" );
	ok( ! isset( $loc["tasks"][1]["check"] ), "a block check with no proper block name is dropped" );
	ok( "site-editor.php?p=%2Fpageb" === $loc["tasks"][2]["check"]["path"], "a screen check keeps its address, %2F and all, and nothing that is not an address: " . $loc["tasks"][2]["check"]["path"] );
	$do = $loc["tasks"][2]["do"];
	ok( 6 === count( $do ) && "button \"Styles\"" === $do[0]["click"] && "styles" === $do[1]["type"] && "Escape" === $do[2]["key"], "a step keeps its clicks, typing and keys, and drops a key it does not know: " . count( $do ) );
	ok( "/wp-admin/site-editor.php" === $do[3]["go"] && 10.0 === $do[4]["wait"] && ! empty( $do[5]["maybe"] ), "go only takes a path on this site, a wait is capped, maybe is kept" );
	ok( false !== strpos( $loc["mark"], "pgut/v1/mark" ), "the card is told where to mark a step" );
	ok( "#6b3fa0" === $loc["theme"]["accent"] && "light" === $loc["theme"]["card"] && ! isset( $loc["theme"]["text"] ), "a tour’s colours reach the card, and only hex colours: " . json_encode( $loc["theme"] ) );
	$GLOBALS["umeta"]["wp_persisted_preferences"] = array( "core/edit-post" => array( "fixedToolbar" => true ) );
	pgut_quiet_guides();
	$p = $GLOBALS["umeta"]["wp_persisted_preferences"];
	ok( false === $p["core/edit-site"]["welcomeGuide"] && false === $p["core/edit-post"]["welcomeGuide"] && false === $p["core/edit-site"]["welcomeGuideStyles"], "on a tour the editors’ welcome guides are turned off" );
	ok( true === $p["core/edit-post"]["fixedToolbar"] && ! empty( $p["_modified"] ), "without touching the user’s other editor settings" );'
);

case_run(
	'a button that is not https',
	'$GLOBALS["opts"] = array( "playground_user_test" => json_encode( array(
		"test" => "abc123defg", "report" => "https://example.test/api/events", "mode" => "tour",
		"button" => array( "label" => "Go", "url" => "javascript:alert(1)" ),
		"tasks" => array( array( "title" => "x" ) ),
	) ) );
	require "' . $plugin . '";
	pgut_enqueue();
	ok( null === $GLOBALS["loc"]["button"], "a button that is not an https link is dropped" );
	$GLOBALS["opts"]["playground_user_test"] = json_encode( array( "test" => "abc123defg", "report" => "https://example.test/api/events", "tasks" => array( array( "title" => "x" ) ) ) );'
);

case_run(
	'a step measured from where it began',
	'$GLOBALS["opts"] = array(
		"pgut_baseline" => array( "max_id" => 10, "styles" => "boot" ),
		"pgut_marks"    => array( "3-font" => array( "max_id" => 14, "styles" => "after-step-2" ) ),
	);
	require "' . $plugin . '";
	ok( "after-step-2" === pgut_base_for( "3-font" )["styles"], "a marked step is checked against the site as the step began" );
	ok( "boot" === pgut_base_for( "1-name" )["styles"], "an unmarked task (every task in a test) keeps the boot baseline" );'
);

case_run(
	'the language the card speaks',
	'$GLOBALS["opts"] = array();
	require "' . $plugin . '";
	ok( "fr_FR" === pgut_lang( array( "lang" => "fr_FR" ) ), "a WordPress locale goes to the card" );
	ok( "de_DE_formal" === pgut_lang( array( "lang" => "de_DE_formal" ) ), "a locale with a variant goes too" );
	ok( "" === pgut_lang( array() ), "no language is English" );
	ok( "" === pgut_lang( array( "lang" => "fr\"><script>" ) ), "anything that is not a locale is dropped" );'
);

case_run(
	'recording a tour',
	'$GLOBALS["opts"] = array( "playground_user_test" => json_encode( array(
		"test" => "record", "report" => "https://example.test/api/events", "mode" => "record",
		"tasks" => array( array( "id" => "1-a", "title" => "Open the editor" ) ),
	) ) );
	require "' . $plugin . '";
	pgut_enqueue();
	ok( "record" === $GLOBALS["loc"]["mode"], "a recording says so to the card" );
	ok( pgut_is_tour( array( "mode" => "record" ) ), "and the site treats it as a tour (welcome guides kept shut)" );'
);

echo $fails ? "\n$fails case(s) failed\n" : "\nall good\n";
exit( $fails ? 1 : 0 );

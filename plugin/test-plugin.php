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
function wp_generate_password( $l, $s ) { return substr( str_shuffle( str_repeat( 'abcdefghijklmnopqrstuvwxyz0123456789', 3 ) ), 0, $l ); }
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
	ok( $GLOBALS["loc"]["session"] === $before, "the same session id comes back on the next page" );'
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

echo $fails ? "\n$fails case(s) failed\n" : "\nall good\n";
exit( $fails ? 1 : 0 );

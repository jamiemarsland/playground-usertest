<?php
/**
 * Plugin Name:       Playground user testing
 * Description:       Shows a tester a small card of things to try, and sends what happens back to the test that sent them.
 * Version:           1.3.0
 * Requires at least: 6.5
 * Requires PHP:      7.4
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 *
 * This is the whole plugin. It does nothing at all unless the site was booted
 * by a test — which is to say, unless the playground_user_test option is there,
 * put in place by the blueprint the tester's link served. On a normal site it
 * is inert.
 *
 * The option carries everything the card needs:
 *
 *   { "test": "<id>", "report": "https://…/api/events",
 *     "subject": "my theme", "tasks": [ { "id", "title", "why", "hint" } ] }
 *
 * A tour adds "mode": "tour", a "button" to end on ({ label, url }), and a
 * "point" on any step: a CSS selector for the thing to click.
 *
 * @package PlaygroundUserTest
 */

defined( 'ABSPATH' ) || exit;

define( 'PGUT_VERSION', '1.3.0' );

/**
 * The test this site was booted for, or nothing.
 *
 * setSiteOptions can leave the value as a JSON string or as an array depending
 * on how the blueprint was written, so both are read.
 *
 * @return array|null
 */
function pgut_test() {
	static $test = false;
	if ( false !== $test ) {
		return $test;
	}

	$raw = get_option( 'playground_user_test' );
	if ( is_string( $raw ) ) {
		$raw = json_decode( $raw, true );
	}

	$test = null;
	if ( is_array( $raw ) && ! empty( $raw['test'] ) && ! empty( $raw['report'] ) && ! empty( $raw['tasks'] ) ) {
		$test = $raw;
	}
	return $test;
}

/**
 * One id for this tester, made once and kept for the life of the site.
 *
 * It is an option rather than something the browser makes, so the card keeps
 * its place when the tester walks between the editor and the published site —
 * and so a reload does not turn one tester into two rows.
 *
 * @return string
 */
function pgut_session() {
	$session = (string) get_option( 'pgut_session', '' );
	if ( ! preg_match( '/^[a-z0-9]{8,32}$/', $session ) ) {
		$session = strtolower( wp_generate_password( 12, false ) );
		update_option( 'pgut_session', $session, false );
	}
	return $session;
}

/**
 * Tidy the tasks before they reach the page.
 *
 * They arrive from the service, which already trimmed them, but this plugin has
 * no way to know that — a blueprint is a file anyone can write.
 *
 * @param array $tasks Tasks as they came in.
 * @return array
 */
function pgut_tasks( $tasks ) {
	$out = array();
	foreach ( array_slice( (array) $tasks, 0, 12 ) as $i => $task ) {
		if ( ! is_array( $task ) || empty( $task['title'] ) ) {
			continue;
		}
		$id    = isset( $task['id'] ) ? preg_replace( '/[^a-z0-9_-]/', '', strtolower( (string) $task['id'] ) ) : '';
		$clean = array(
			'id'    => $id ? substr( $id, 0, 40 ) : 'task-' . ( $i + 1 ),
			'title' => sanitize_text_field( (string) $task['title'] ),
		);
		foreach ( array( 'why', 'hint', 'say' ) as $extra ) {
			if ( ! empty( $task[ $extra ] ) ) {
				$clean[ $extra ] = substr( sanitize_text_field( (string) $task[ $extra ] ), 0, 600 );
			}
		}
		// a selector only ever goes to querySelector, never into the page as markup
		if ( ! empty( $task['point'] ) && is_string( $task['point'] ) ) {
			$clean['point'] = substr( sanitize_text_field( $task['point'] ), 0, 200 );
		}
		// a recording of the step's words; only ever an audio source
		if ( ! empty( $task['audio'] ) && is_string( $task['audio'] ) && preg_match( '#^https?://#', $task['audio'] ) ) {
			$clean['audio'] = esc_url_raw( $task['audio'] );
		}
		$actions = pgut_actions( isset( $task['do'] ) ? $task['do'] : null );
		if ( $actions ) {
			$clean['do'] = $actions;
		}
		if ( ! empty( $task['check'] ) && is_array( $task['check'] ) && ! empty( $task['check']['type'] ) ) {
			$type = preg_replace( '/[^a-z_]/', '', (string) $task['check']['type'] );
			if ( in_array( $type, pgut_check_types(), true ) ) {
				$clean['check'] = array( 'type' => $type );
				if ( 'text' === $type && ! empty( $task['check']['text'] ) ) {
					$clean['check']['text'] = sanitize_text_field( (string) $task['check']['text'] );
				}
				if ( 'page' === $type ) {
					// address characters only; sanitize_text_field would eat %2F
					$path = isset( $task['check']['path'] ) ? substr( preg_replace( '/[^A-Za-z0-9_\-.\/%?=&#]/', '', (string) $task['check']['path'] ), 0, 120 ) : '';
					if ( '' === $path ) {
						unset( $clean['check'] );
					} else {
						$clean['check']['path'] = $path;
					}
				}
				if ( 'block' === $type || 'block_changed' === $type ) {
					$name = isset( $task['check']['block'] ) ? strtolower( (string) $task['check']['block'] ) : '';
					if ( ! preg_match( '#^[a-z0-9-]+/[a-z0-9-]+$#', $name ) ) {
						unset( $clean['check'] );
					} else {
						$clean['check']['block'] = $name;
					}
				}
			}
		}
		$out[] = $clean;
	}
	return $out;
}

/**
 * What a tour step presses, types or opens by itself, cleaned: up to ten
 * actions, each one of click, type + into, key, go (a path on this site) or
 * wait. The service cleaned them already; a blueprint is a file anyone writes.
 *
 * @param mixed $raw Actions as they came in.
 * @return array
 */
function pgut_actions( $raw ) {
	$out = array();
	foreach ( array_slice( is_array( $raw ) ? $raw : array(), 0, 10 ) as $a ) {
		if ( ! is_array( $a ) ) {
			continue;
		}
		$one = array();
		if ( ! empty( $a['click'] ) && is_string( $a['click'] ) ) {
			$one['click'] = substr( sanitize_text_field( $a['click'] ), 0, 200 );
		} elseif ( isset( $a['type'], $a['into'] ) && is_string( $a['type'] ) && is_string( $a['into'] ) ) {
			$one['type'] = substr( sanitize_text_field( $a['type'] ), 0, 120 );
			$one['into'] = substr( sanitize_text_field( $a['into'] ), 0, 200 );
		} elseif ( isset( $a['key'] ) && in_array( $a['key'], array( 'Escape', 'Enter', 'Tab' ), true ) ) {
			$one['key'] = $a['key'];
		} elseif ( isset( $a['go'] ) && is_string( $a['go'] ) && preg_match( '#^/[^\s<>"]*$#', $a['go'] ) ) {
			$one['go'] = substr( $a['go'], 0, 200 );
		} elseif ( isset( $a['wait'] ) && is_numeric( $a['wait'] ) ) {
			$one['wait'] = (float) min( 10, max( 0.5, (float) $a['wait'] ) );
		} else {
			continue;
		}
		if ( ! empty( $a['maybe'] ) ) {
			$one['maybe'] = true;
		}
		$out[] = $one;
	}
	return $out;
}

/**
 * Put the card on the page — the editor and the site both, since a tester
 * walks between them and the list of tasks has to follow.
 *
 * @return void
 */
function pgut_enqueue() {
	$test = pgut_test();
	if ( ! $test || ! is_user_logged_in() || ! current_user_can( 'edit_posts' ) ) {
		return;
	}

	$tasks = pgut_tasks( $test['tasks'] );
	if ( ! $tasks ) {
		return;
	}

	wp_enqueue_script( 'pgut-card', plugins_url( 'card.js', __FILE__ ), array(), PGUT_VERSION, true );
	wp_localize_script(
		'pgut-card',
		'PGUT',
		array(
			'test'    => sanitize_text_field( (string) $test['test'] ),
			'report'  => esc_url_raw( (string) $test['report'] ),
			'subject' => isset( $test['subject'] ) ? sanitize_text_field( (string) $test['subject'] ) : '',
			'session' => pgut_session(),
			'tasks'   => array_values( $tasks ),
			'rest'    => esc_url_raw( rest_url( 'pgut/v1/check' ) ),
			'mark'    => esc_url_raw( rest_url( 'pgut/v1/mark' ) ),
			'nonce'   => wp_create_nonce( 'wp_rest' ),
			'home'    => esc_url_raw( home_url( '/' ) ),
			// the test's own closing questions, if it has any; the card has defaults
			'questions' => pgut_questions( $test ),
			'mode'    => pgut_is_tour( $test ) ? 'tour' : 'test',
			'button'  => pgut_button( $test ),
			'endAudio' => isset( $test['endAudio'] ) && is_string( $test['endAudio'] ) && preg_match( '#^https?://#', $test['endAudio'] ) ? esc_url_raw( $test['endAudio'] ) : '',
		)
	);
}

/**
 * Is this a tour — steps that show something — rather than a test?
 *
 * @param array $test The test option.
 * @return bool
 */
function pgut_is_tour( $test ) {
	return isset( $test['mode'] ) && 'tour' === $test['mode'];
}

/**
 * The button a tour ends on, cleaned: words and an https link, or nothing.
 *
 * @param array $test The test option.
 * @return array|null
 */
function pgut_button( $test ) {
	$raw = isset( $test['button'] ) && is_array( $test['button'] ) ? $test['button'] : array();
	$label = isset( $raw['label'] ) ? sanitize_text_field( (string) $raw['label'] ) : '';
	$url   = isset( $raw['url'] ) ? esc_url_raw( (string) $raw['url'] ) : '';
	if ( '' === $label || 0 !== strpos( $url, 'https://' ) ) {
		return null;
	}
	return array( 'label' => substr( $label, 0, 60 ), 'url' => $url );
}

/**
 * The closing questions a test put in its own words, cleaned. Only the four
 * the card asks are kept, and only when there is something to say.
 *
 * @param array $test The test option.
 * @return array
 */
function pgut_questions( $test ) {
	$out = array();
	$raw = isset( $test['questions'] ) && is_array( $test['questions'] ) ? $test['questions'] : array();
	foreach ( array( 'happy', 'finish', 'feel', 'confused' ) as $key ) {
		if ( isset( $raw[ $key ] ) && is_string( $raw[ $key ] ) ) {
			$text = sanitize_text_field( $raw[ $key ] );
			if ( '' !== $text ) {
				$out[ $key ] = $text;
			}
		}
	}
	return (object) $out;
}
add_action( 'wp_enqueue_scripts', 'pgut_enqueue', 20 );

/**
 * On a tour, the editors' welcome guides stay shut. A tour presses through
 * the editor by itself, and a popup over the middle of it is in the way. A
 * test leaves them alone: someone new to WordPress would meet them.
 *
 * They are the user's saved editor preferences, so they are turned off there,
 * dated now so they win over anything the browser kept from before.
 *
 * @return void
 */
function pgut_quiet_guides() {
	$test = pgut_test();
	if ( ! $test || ! pgut_is_tour( $test ) || ! is_user_logged_in() ) {
		return;
	}
	global $wpdb;
	$user  = get_current_user_id();
	$key   = $wpdb->get_blog_prefix() . 'persisted_preferences';
	$prefs = get_user_meta( $user, $key, true );
	$prefs = is_array( $prefs ) ? $prefs : array();
	$off   = array(
		'core/edit-site'         => array( 'welcomeGuide', 'welcomeGuideStyles', 'welcomeGuidePage', 'welcomeGuideTemplate' ),
		'core/edit-post'         => array( 'welcomeGuide', 'welcomeGuideTemplate' ),
		'core/edit-widgets'      => array( 'welcomeGuide' ),
		'core/customize-widgets' => array( 'welcomeGuide' ),
	);
	$changed = false;
	foreach ( $off as $scope => $names ) {
		foreach ( $names as $name ) {
			if ( ! isset( $prefs[ $scope ][ $name ] ) || false !== $prefs[ $scope ][ $name ] ) {
				$prefs[ $scope ][ $name ] = false;
				$changed                  = true;
			}
		}
	}
	if ( $changed ) {
		$prefs['_modified'] = gmdate( 'Y-m-d\TH:i:s.000\Z' );
		update_user_meta( $user, $key, $prefs );
	}
}
add_action( 'admin_init', 'pgut_quiet_guides' );
add_action( 'admin_enqueue_scripts', 'pgut_enqueue', 20 );

/* ------------------------------------------------------------- the checks */

/**
 * The ways a task can be checked against the site itself, rather than taken on
 * the Done button's word. People press Done on things they did not manage more
 * often than anyone expects; the site keeps count honestly.
 *
 * @return string[]
 */
function pgut_check_types() {
	return array( 'site_name', 'tagline', 'site_icon', 'logo', 'new_page', 'new_post', 'styles', 'menu', 'home', 'text', 'block', 'block_changed', 'page' );
}

/**
 * A fingerprint of some rows: their ids and contents, in order.
 *
 * Read as plain rows and joined here rather than with CONCAT in SQL, because
 * Playground's database is SQLite behind a translator, and the plainer the
 * query the fewer surprises.
 *
 * @param string $where SQL condition on the posts table (no user input).
 * @return string
 */
function pgut_fingerprint( $where ) {
	global $wpdb;
	$rows = $wpdb->get_results( "SELECT ID, post_status, post_content FROM {$wpdb->posts} WHERE {$where} ORDER BY ID", ARRAY_N );
	$parts = array();
	foreach ( (array) $rows as $row ) {
		$parts[] = implode( ':', array_map( 'strval', (array) $row ) );
	}
	return md5( implode( "\n", $parts ) );
}

/**
 * What a saved global styles record actually changes, or '' when it changes
 * nothing.
 *
 * Opening the Site Editor makes WordPress create the user's styles record
 * before anyone touches a colour: {"version":3,"isGlobalStylesUserThemeJSON":true}.
 * A new row is not a new look, so the bookkeeping keys are dropped and an
 * empty record counts as no record.
 *
 * @param string $content A wp_global_styles post_content.
 * @return string
 */
function pgut_styles_content( $content ) {
	$data = json_decode( (string) $content, true );
	if ( ! is_array( $data ) ) {
		return trim( (string) $content );
	}
	unset( $data['version'], $data['isGlobalStylesUserThemeJSON'] );
	$data = array_filter(
		$data,
		function ( $v ) {
			return array() !== $v && '' !== $v && null !== $v;
		}
	);
	return $data ? (string) json_encode( $data ) : '';
}

/**
 * A fingerprint of the looks the tester has saved, ignoring empty records.
 *
 * @return string
 */
function pgut_styles_fingerprint() {
	global $wpdb;
	$rows  = $wpdb->get_col( "SELECT post_content FROM {$wpdb->posts} WHERE post_type = 'wp_global_styles' AND post_status = 'publish' ORDER BY ID" );
	$parts = array_filter( array_map( 'pgut_styles_content', (array) $rows ) );
	return md5( implode( "\n", $parts ) );
}

/**
 * The site right now, in the few ways a check can ask about.
 *
 * @return array
 */
function pgut_snapshot() {
	global $wpdb;
	$front = (int) get_option( 'page_on_front' );
	return array(
		'site_name' => (string) get_option( 'blogname' ),
		'tagline'   => (string) get_option( 'blogdescription' ),
		'site_icon' => (int) get_option( 'site_icon' ),
		'logo'      => (int) get_theme_mod( 'custom_logo' ) . ':' . (int) get_option( 'site_logo' ),
		'styles'    => pgut_styles_fingerprint(),
		'menu'      => pgut_fingerprint( "post_type IN ('wp_navigation', 'nav_menu_item')" ),
		// the front page's own words, and any template or template part the
		// tester has saved (a block theme's home lives in its templates)
		'home'      => md5( ( $front ? (string) get_post_field( 'post_content', $front ) : '' ) . pgut_fingerprint( "post_type IN ('wp_template', 'wp_template_part')" ) ),
		'max_id'    => (int) $wpdb->get_var( "SELECT MAX(ID) FROM {$wpdb->posts}" ),
	);
}

/**
 * The site as the tester found it: taken once, on the first page anyone loads
 * after the blueprint finished, and kept.
 *
 * @return array
 */
function pgut_baseline() {
	$base = get_option( 'pgut_baseline' );
	if ( is_array( $base ) && isset( $base['max_id'] ) ) {
		return $base;
	}
	$base = pgut_snapshot();
	update_option( 'pgut_baseline', $base, false );
	return $base;
}

/**
 * What a step's check compares with. A tour marks the site as each step
 * begins, so step three is measured from where step two left it: otherwise a
 * styles change in step two answers "yes" for every later styles step before
 * anyone has touched it. A test never marks, and so keeps the boot baseline.
 *
 * @param string $task Task id.
 * @return array
 */
function pgut_base_for( $task ) {
	$marks = get_option( 'pgut_marks' );
	if ( is_array( $marks ) && isset( $marks[ $task ]['max_id'] ) ) {
		return $marks[ $task ];
	}
	return pgut_baseline();
}

/**
 * Take the baseline before the tester can touch anything.
 *
 * @return void
 */
function pgut_take_baseline() {
	if ( pgut_test() ) {
		pgut_baseline();
	}
}
add_action( 'init', 'pgut_take_baseline', 99 );

/**
 * Did the site change the way this check asks? yes, no, or client (the card
 * reads the home page itself for words, as a visitor would see them).
 *
 * @param array $check { type, text? }.
 * @return string
 */
function pgut_check( $check, $base = null ) {
	global $wpdb;
	$type = isset( $check['type'] ) ? (string) $check['type'] : '';
	$base = is_array( $base ) ? $base : pgut_baseline();
	$now  = pgut_snapshot();
	switch ( $type ) {
		case 'site_name':
		case 'tagline':
		case 'logo':
		case 'styles':
		case 'menu':
		case 'home':
			return $now[ $type ] !== $base[ $type ] ? 'yes' : 'no';
		case 'site_icon':
			return ( $now['site_icon'] && $now['site_icon'] !== $base['site_icon'] ) ? 'yes' : 'no';
		case 'new_page':
		case 'new_post':
			// a tour step: published since the step began, counting a draft
			// the editor saved before it did (the editor saves early and often)
			$kind = 'new_page' === $type ? 'page' : 'post';
			if ( isset( $base['fresh'][ $kind ] ) ) {
				$fresh = pgut_fresh_counts( pgut_baseline() );
				return $fresh[ $kind ] > (int) $base['fresh'][ $kind ] ? 'yes' : 'no';
			}
			$count = (int) $wpdb->get_var(
				$wpdb->prepare(
					"SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = %s AND post_status = 'publish' AND ID > %d",
					'new_page' === $type ? 'page' : 'post',
					(int) $base['max_id']
				)
			);
			return $count ? 'yes' : 'no';
		case 'text':
		case 'block':
		case 'block_changed':
		case 'page':
			// words as a visitor sees them, blocks in the editor before
			// anything is saved, and which screen they are on: the card reads
			// all three itself
			return 'client';
	}
	return 'unknown';
}

/**
 * GET pgut/v1/check?task=<id> — the check comes from the test's own option,
 * never from the request, so the answer cannot be steered from the browser.
 *
 * @param WP_REST_Request $req Request.
 * @return array|WP_Error
 */
function pgut_rest_check( $req ) {
	$test = pgut_test();
	if ( ! $test ) {
		return new WP_Error( 'pgut_not_a_test', 'This site is not a test.', array( 'status' => 404 ) );
	}
	$id = preg_replace( '/[^a-z0-9_-]/', '', strtolower( (string) $req['task'] ) );
	foreach ( pgut_tasks( $test['tasks'] ) as $task ) {
		if ( $task['id'] === $id ) {
			return array( 'result' => empty( $task['check'] ) ? 'unknown' : pgut_check( $task['check'], pgut_base_for( $id ) ) );
		}
	}
	return array( 'result' => 'unknown' );
}

/**
 * How many posts and pages made since the boot are published now.
 *
 * @param array $boot The boot baseline.
 * @return array { post: int, page: int }
 */
function pgut_fresh_counts( $boot ) {
	global $wpdb;
	$out = array();
	foreach ( array( 'post', 'page' ) as $kind ) {
		$out[ $kind ] = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = %s AND post_status = 'publish' AND ID > %d",
				$kind,
				(int) $boot['max_id']
			)
		);
	}
	return $out;
}

/**
 * POST pgut/v1/mark?task=<id> — a tour step has begun; remember the site as
 * it is now, for that step's check. The first mark stands, so a reload in the
 * middle of a step does not move the line the step is measured from.
 *
 * @param WP_REST_Request $req Request.
 * @return array|WP_Error
 */
function pgut_rest_mark( $req ) {
	$test = pgut_test();
	if ( ! $test ) {
		return new WP_Error( 'pgut_not_a_test', 'This site is not a test.', array( 'status' => 404 ) );
	}
	$id    = preg_replace( '/[^a-z0-9_-]/', '', strtolower( (string) $req['task'] ) );
	$known = wp_list_pluck( pgut_tasks( $test['tasks'] ), 'id' );
	if ( ! in_array( $id, $known, true ) ) {
		return array( 'ok' => false );
	}
	$marks = get_option( 'pgut_marks' );
	$marks = is_array( $marks ) ? $marks : array();
	if ( ! isset( $marks[ $id ] ) ) {
		$boot          = pgut_baseline(); // the boot baseline is taken first, whatever happens
		$marks[ $id ]  = pgut_snapshot();
		$marks[ $id ]['fresh'] = pgut_fresh_counts( $boot );
		update_option( 'pgut_marks', $marks, false );
	}
	return array( 'ok' => true );
}

/**
 * The route the card asks.
 *
 * @return void
 */
function pgut_routes() {
	register_rest_route(
		'pgut/v1',
		'/check',
		array(
			'methods'             => 'GET',
			'callback'            => 'pgut_rest_check',
			'permission_callback' => function () {
				return current_user_can( 'edit_posts' );
			},
			'args'                => array( 'task' => array( 'type' => 'string', 'required' => true ) ),
		)
	);
	register_rest_route(
		'pgut/v1',
		'/mark',
		array(
			'methods'             => 'POST',
			'callback'            => 'pgut_rest_mark',
			'permission_callback' => function () {
				return current_user_can( 'edit_posts' );
			},
			'args'                => array( 'task' => array( 'type' => 'string', 'required' => true ) ),
		)
	);
}
add_action( 'rest_api_init', 'pgut_routes' );

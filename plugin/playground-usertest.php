<?php
/**
 * Plugin Name:       Playground user testing
 * Description:       Shows a tester a small card of things to try, and sends what happens back to the test that sent them.
 * Version:           1.0.0
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
 * @package PlaygroundUserTest
 */

defined( 'ABSPATH' ) || exit;

define( 'PGUT_VERSION', '1.0.0' );

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
		foreach ( array( 'why', 'hint' ) as $extra ) {
			if ( ! empty( $task[ $extra ] ) ) {
				$clean[ $extra ] = sanitize_text_field( (string) $task[ $extra ] );
			}
		}
		$out[] = $clean;
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
		)
	);
}
add_action( 'wp_enqueue_scripts', 'pgut_enqueue', 20 );
add_action( 'admin_enqueue_scripts', 'pgut_enqueue', 20 );

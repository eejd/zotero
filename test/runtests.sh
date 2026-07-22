#!/bin/bash
set -o pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$( dirname "$SCRIPT_DIR" )" && pwd )"
TEST_PORT="${ZOTERO_TEST_PORT:-23124}"
RUN_TIMEOUT="${ZOTERO_TEST_RUN_TIMEOUT:-1800}"
CHILD_PID=""
LOCK_DIR=""
LOCK_OWNED=0

[[ "$TEST_PORT" =~ ^[0-9]+$ ]] && [ "$TEST_PORT" -ge 1 ] && [ "$TEST_PORT" -le 65535 ] \
	|| { echo "ZOTERO_TEST_PORT must be an integer from 1 to 65535" >&2; exit 2; }
[[ "$RUN_TIMEOUT" =~ ^[0-9]+$ ]] && [ "$RUN_TIMEOUT" -ge 1 ] \
	|| { echo "ZOTERO_TEST_RUN_TIMEOUT must be a positive integer" >&2; exit 2; }

case "$OSTYPE" in
  msys*|mingw*|cygwin*) IS_CYGWIN=1 ;;
esac

function makePath {
	local __assignTo=$1
	local __path=$2
	if [ ! -z $IS_CYGWIN ]; then
		__path="`cygpath -aw \"$__path\"`"
	fi
	eval $__assignTo="'$__path'"
}

if [ -z "$Z_EXECUTABLE" ]; then
	if [ "`uname`" == "Darwin" ]; then
		Z_EXECUTABLE="$ROOT_DIR/app/staging/Zotero.app/Contents/MacOS/zotero"
	else
		arch=""
		if [ "$(uname -m)" = "aarch64" ]; then
			arch="arm64"
		else
			arch="x86_64"
		fi
		Z_EXECUTABLE="$ROOT_DIR/app/staging/Zotero_linux-$arch/zotero"
	fi
fi

if [ -z "$DISPLAY" ]; then
	Z_ARGS=""
else
	Z_ARGS="--class=ZTestFirefox"
fi

function usage {
	cat >&2 <<DONE
Usage: $0 [option] [TESTS...]
Options
 -b                  skip bundled translator/style installation
 -c                  open JavaScript console and don't quit on completion
 -d LEVEL            enable debug logging
 -e TEST             end at the given test
 -f                  stop after first test failure
 -g                  only run tests matching the given pattern (grep)
 -h                  display this help
 -r RETRIES          retry failed tests the given number of times (default: 0)
 -s TEST             start at the given test
 -t                  generate test data and quit
 -x EXECUTABLE       path to Zotero executable (default: $Z_EXECUTABLE)
 TESTS               set of tests to run (default: all)
DONE
	exit 1
}

DEBUG=false
DEBUG_LEVEL=5
RETRIES=0
while getopts "bcd:e:fg:hr:s:tx:" opt; do
	case $opt in
        b)
        	Z_ARGS="$Z_ARGS -ZoteroSkipBundledFiles"
        	;;
		c)
			Z_ARGS="$Z_ARGS -jsconsole -noquit"
			;;
		d)
			DEBUG=true
			DEBUG_LEVEL="$OPTARG"
			;;
		e)
			if [[ -z "$OPTARG" ]] || [[ ${OPTARG:0:1} = "-" ]]; then
				usage
			fi
			Z_ARGS="$Z_ARGS -stopAtTestFile $OPTARG"
			;;
		f)
			Z_ARGS="$Z_ARGS -bail"
			;;
		g)
			GREP="$OPTARG"
			;;
		h)
			usage
			;;
		r)
			RETRIES="$OPTARG"
			;;
		s)
			if [[ -z "$OPTARG" ]] || [[ ${OPTARG:0:1} = "-" ]]; then
				usage
			fi
			Z_ARGS="$Z_ARGS -startAtTestFile $OPTARG"
			;;
		t)
			Z_ARGS="$Z_ARGS -makeTestData"
			;;
		x)
			Z_EXECUTABLE="$OPTARG"
			;;
		*)
			usage
			;;
	esac
	shift $((OPTIND-1)); OPTIND=1
done

if [ -z $1 ]; then
	TESTS="all"
else
	ARGS=("${@:1}")
	function join { local IFS="$1"; shift; echo "$*"; }
	TESTS="$(join , "${ARGS[@]}")"
fi

# Increase open files limit
#
# Mozilla file functions (OS.File.move()/copy(), NetUtil.asyncFetch/asyncCopy()) can leave file
# descriptors open for a few seconds (even with an explicit inputStream.close() in the case of
# the latter), so a source installation that copies ~500 translators and styles (with fds for
# source and target) can exceed the default 1024 limit.
ulimit -n 4096

# Set up profile directory
TEMPDIR="`mktemp -d 2>/dev/null || mktemp -d -t 'zotero-unit'`"
PROFILE="$TEMPDIR/profile"
mkdir -p "$PROFILE"

makePath ZOTERO_PATH "$ROOT_DIR/build"

# Create data directory
mkdir "$TEMPDIR/Zotero"

touch "$PROFILE/prefs.js"
cat <<EOF >> "$PROFILE/prefs.js"
user_pref("app.update.enabled", false);
//user_pref("dom.max_chrome_script_run_time", 0);
// It would be better to leave this on and handle it in Sinon's FakeXMLHttpRequest
user_pref("extensions.zotero.sync.server.compressData", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.zotero.debug.log", $DEBUG);
user_pref("extensions.zotero.debug.level", $DEBUG_LEVEL);
user_pref("extensions.zotero.debug.time", $DEBUG);
user_pref("extensions.zotero.firstRun.skipFirefoxProfileAccessCheck", true);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.reportTranslationFailure", false);
user_pref("extensions.zotero.httpServer.enabled", true);
user_pref("extensions.zotero.httpServer.port", $TEST_PORT);
user_pref("extensions.zotero.httpServer.localAPI.enabled", true);
user_pref("extensions.zotero.backup.numBackups", 0);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zoteroMacWordIntegration.installed", true);
user_pref("extensions.zoteroMacWordIntegration.skipInstallation", true);
user_pref("extensions.zoteroWinWordIntegration.skipInstallation", true);
user_pref("extensions.zoteroOpenOfficeIntegration.skipInstallation", true);
EOF

if [ -n "$CI" ]; then
	Z_ARGS="$Z_ARGS -ZoteroAutomatedTest -ZoteroTestTimeout 15000 -ZoteroDebugText"
else
	Z_ARGS="$Z_ARGS -jsconsole"
fi

function cleanup {
	local status=$?
	if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
		kill "$CHILD_PID" 2>/dev/null || true
	fi
	rm -rf "$TEMPDIR"
	if [ "$LOCK_OWNED" = "1" ] && [ -n "$LOCK_DIR" ]; then
		rm -rf "$LOCK_DIR"
	fi
	return $status
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

function lock_identity {
	if [ "$(uname)" = "Darwin" ]; then
		local plist identity=""
		plist="$(dirname "$(dirname "$Z_EXECUTABLE")")/Info.plist"
		if [ -f "$plist" ]; then
			identity="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null || true)"
		fi
		echo "${ZOTERO_TEST_BUNDLE_ID:-${identity:-org.zotero.zotero-source}}"
	else
		echo "${ZOTERO_TEST_BUNDLE_ID:-zotero@zotero.org}"
	fi
}

function acquire_lock {
	local identity safe_identity lock_root owner
	identity="$(lock_identity)"
	safe_identity="$(printf '%s' "$identity" | tr -c 'A-Za-z0-9_.-' '_')"
	lock_root="${ZOTERO_TEST_LOCK_ROOT:-${TMPDIR:-/tmp}/zotero-test-locks}"
	LOCK_DIR="$lock_root/${safe_identity}-port-$TEST_PORT.lock"
	mkdir -p "$lock_root"
	if ! mkdir "$LOCK_DIR" 2>/dev/null; then
		owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
		if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
			echo "REFUSING duplicate Zotero test run: pid $owner owns $identity on port $TEST_PORT ($LOCK_DIR)" >&2
			exit 1
		fi
		echo "Removing stale Zotero test lock $LOCK_DIR (recorded pid ${owner:-unknown})" >&2
		rm -rf "$LOCK_DIR"
		mkdir "$LOCK_DIR" || { echo "Could not acquire Zotero test lock $LOCK_DIR" >&2; exit 1; }
	fi
	printf '%s\n' "$$" > "$LOCK_DIR/pid"
	printf '%s\n' "$identity" > "$LOCK_DIR/identity"
	LOCK_OWNED=1
}

function validate_staging {
	local app_root app_resources app_omni runtime_omni updater missing=0
	if [ "$(uname)" = "Darwin" ]; then
		app_root="$ROOT_DIR/app/staging/Zotero.app/Contents"
		app_resources="$app_root/Resources/app"
		updater="$app_root/MacOS/updater.app/Contents/MacOS/org.mozilla.updater"
		runtime_omni="$app_root/Resources/omni.ja"
	else
		app_root="$(dirname "$Z_EXECUTABLE")"
		app_resources="$app_root/app"
		if [ -n "$IS_CYGWIN" ]; then updater="$app_root/updater.exe"; else updater="$app_root/updater"; fi
		runtime_omni="$app_root/omni.ja"
	fi
	app_omni="$app_resources/omni.ja"
	for path in \
		"$app_resources/application.ini" \
		"$runtime_omni" \
		"$app_omni" \
		"$updater" \
		"$Z_EXECUTABLE"; do
		if [ ! -f "$path" ]; then echo "Missing required staging artifact: $path" >&2; missing=1; fi
	done
	if [ "$missing" = "0" ]; then
		for resource in test/content/runtests.js test/components/zotero-unit.js test/tests/serverTest.js; do
			if ! unzip -Z1 "$app_omni" | grep -Fx "$resource" >/dev/null; then
				echo "Missing required test resource in $app_omni: $resource" >&2
				missing=1
			fi
		done
	fi
	[ "$missing" = "0" ] || return 1
	[ -x "$Z_EXECUTABLE" ] || { echo "Staging executable is not executable: $Z_EXECUTABLE" >&2; return 1; }
}

function report_launch_failure {
	local reason="$1"
	echo "$reason" >&2
	echo "Zotero test log: $STAGING_LOG" >&2
	if [ -s "$STAGING_LOG" ]; then
		echo "--- log tail ---" >&2
		tail -n 80 "$STAGING_LOG" >&2
	fi
	if [ "$(uname)" = "Darwin" ]; then
		echo "Native crash reports: $HOME/Library/Logs/DiagnosticReports" >&2
	else
		echo "Crash dumps, if generated: $PROFILE/minidumps" >&2
	fi
}

acquire_lock

# Check if build watch process is running
# If not, run now
if [[ -z "$CI" ]] && ! ps | grep js-build/build.js | grep -v grep > /dev/null; then
	echo
	echo "Running JS build process"
	cd "$ROOT_DIR"
	NODE_OPTIONS=--openssl-legacy-provider npm run build || exit $?
	echo
fi

if ! ZOTERO_TEST=1 "$ROOT_DIR/app/scripts/dir_build" -q; then
	echo "Zotero test build failed; refusing to launch an incomplete staging application" >&2
	exit 1
fi

validate_staging || {
	echo "Zotero test staging validation failed; refusing to launch" >&2
	exit 1
}

makePath FX_PROFILE "$PROFILE"
STAGING_LOG="${ZOTERO_TEST_LOG:-$ROOT_DIR/app/staging/zotero-test.log}"
: > "$STAGING_LOG"
MOZ_NO_REMOTE=1 NO_EM_RESTART=1 "$Z_EXECUTABLE" -no-remote -profile "$FX_PROFILE" \
    -test "$TESTS" -grep "$GREP" -retries "$RETRIES" -ZoteroTest $Z_ARGS \
    >"$STAGING_LOG" 2>&1 &
CHILD_PID=$!
printf '%s\n' "$CHILD_PID" > "$LOCK_DIR/pid"

start_time=$(date +%s)
while kill -0 "$CHILD_PID" 2>/dev/null; do
	if [ $(( $(date +%s) - start_time )) -ge "$RUN_TIMEOUT" ]; then
		report_launch_failure "Zotero test run timed out after ${RUN_TIMEOUT}s (pid $CHILD_PID)"
		kill "$CHILD_PID" 2>/dev/null || true
		wait "$CHILD_PID" 2>/dev/null || true
		CHILD_PID=""
		exit 124
	fi
	sleep 1
done

wait "$CHILD_PID"
CHILD_STATUS=$?
CHILD_PID=""

# Check for success
if [ "$CHILD_STATUS" != "0" ] || [ ! -e "$PROFILE/success" ]; then
	FAILURE_STATUS="$CHILD_STATUS"
	[ "$FAILURE_STATUS" != "0" ] || FAILURE_STATUS=1
	report_launch_failure "Zotero exited before reporting test success (status $CHILD_STATUS)"
	exit "$FAILURE_STATUS"
fi

exit 0

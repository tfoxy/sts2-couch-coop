#!/usr/bin/env bash
# Resolve a Windows QA host's current LAN address, and optionally connect to it.
#
# Why this exists: a physical Windows QA box gets its address from DHCP, and it DOES drift -- the rig
# this was written for moved between two addresses inside a month while keeping the same MAC. Pinning
# an IP in ~/.ssh/config therefore breaks silently and looks like "the machine is down".
#
# Resolution order, first hit wins:
#   1. $COUCHCOOP_WIN_HOST_ADDR   -- explicit override, for when name resolution is unavailable
#   2. nmblookup <name>           -- NetBIOS broadcast; Windows answers this out of the box
#   3. ip neigh, matched by MAC   -- needs $COUCHCOOP_WIN_HOST_MAC; REACHABLE entries only
#
# Usage:
#   win-host-addr.sh                 # print the address
#   win-host-addr.sh --nc <port>     # exec nc <addr> <port>, for ssh_config ProxyCommand
#   win-host-addr.sh --check         # print the address and which method found it
#
# Configure with (no defaults are baked in -- the host identity is local state, not repo content):
#   COUCHCOOP_WIN_HOST_NAME   NetBIOS/computer name, e.g. MY-LAPTOP
#   COUCHCOOP_WIN_HOST_MAC    MAC for the ip-neigh fallback, colon-separated lower case
#   COUCHCOOP_WIN_HOST_ADDR   hard override; skips discovery entirely
#
# Typical ~/.ssh/config block (that file is not committed; see docs/agents/windows-home-rig.md):
#   Host win-home
#       User <account>
#       IdentityFile ~/.ssh/couchcoop-qa
#       IdentitiesOnly yes
#       ProxyCommand ~/.ssh/win-host-addr.sh --nc %p
#
# sh expands the leading ~ in a ProxyCommand, so symlink this script into ~/.ssh/ rather than
# referencing a checkout path (a repo path here would be user-specific and must not be committed).

set -euo pipefail

mode="print"
port=""

while [ $# -gt 0 ]; do
    case "$1" in
        --nc)
            mode="nc"
            port="${2:-}"
            if [ -z "$port" ]; then
                echo "win-host-addr.sh: --nc needs a port" >&2
                exit 2
            fi
            shift 2
            ;;
        --check)
            mode="check"
            shift
            ;;
        -h|--help)
            sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "win-host-addr.sh: unknown argument '$1'" >&2
            exit 2
            ;;
    esac
done

addr=""
via=""

# 1. Explicit override.
if [ -n "${COUCHCOOP_WIN_HOST_ADDR:-}" ]; then
    addr="$COUCHCOOP_WIN_HOST_ADDR"
    via="COUCHCOOP_WIN_HOST_ADDR"
fi

# 2. NetBIOS broadcast. Note: NO -R. That flag asks a WINS server instead of broadcasting, and on a
# plain home LAN it returns nothing at all -- measured, and it looks exactly like "host is down".
if [ -z "$addr" ] && [ -n "${COUCHCOOP_WIN_HOST_NAME:-}" ] && command -v nmblookup >/dev/null 2>&1; then
    found="$(nmblookup "$COUCHCOOP_WIN_HOST_NAME" 2>/dev/null | awk '/^[0-9]+\./ { print $1; exit }' || true)"
    if [ -n "$found" ]; then
        addr="$found"
        via="nmblookup $COUCHCOOP_WIN_HOST_NAME"
    fi
fi

# 3. MAC match in the neighbour table, then VERIFY.
#
# Two things make this branch subtle, and both were measured rather than assumed:
#   - A stale entry survives a lease change, so one MAC can legitimately show two addresses -- the
#     current one and the one the box used to have. An unfiltered match returns whichever comes first.
#   - Filtering to REACHABLE does NOT fix that. A live host normally sits at STALE or DELAY; REACHABLE
#     holds only for a moment after confirmed traffic, so a REACHABLE-only filter rejects the host you
#     are looking at nearly every time.
#
# The neighbour table simply cannot say which address is current, so probe the candidates instead: try
# a TCP connect to the port we actually want, newest-looking states first, and take the one that
# answers. That is the only discriminator that means anything here.
if [ -z "$addr" ] && [ -n "${COUCHCOOP_WIN_HOST_MAC:-}" ] && command -v ip >/dev/null 2>&1; then
    mac_lower="$(printf '%s' "$COUCHCOOP_WIN_HOST_MAC" | tr 'A-Z-' 'a-z:')"

    candidates="$(ip neigh show 2>/dev/null \
        | awk -v mac="$mac_lower" '
            tolower($0) ~ mac && !/FAILED|INCOMPLETE/ {
                rank = 3
                if ($0 ~ /REACHABLE/) rank = 0
                else if ($0 ~ /DELAY/) rank = 1
                else if ($0 ~ /STALE/) rank = 2
                print rank, $1
            }' \
        | sort -n -k1,1 | awk '{ print $2 }' || true)"

    verify_port="${port:-22}"
    for candidate in $candidates; do
        if timeout 3 bash -c "echo > /dev/tcp/$candidate/$verify_port" 2>/dev/null; then
            addr="$candidate"
            via="ip neigh (MAC $mac_lower), verified by tcp/$verify_port"
            break
        fi
    done

    # Nothing answered on that port. Say so with the candidate list rather than guessing one: naming a
    # wrong address is worse than admitting the table was ambiguous.
    if [ -z "$addr" ] && [ -n "$candidates" ]; then
        {
            echo "win-host-addr.sh: MAC $mac_lower matched these addresses, none answering tcp/$verify_port:"
            for candidate in $candidates; do echo "    $candidate"; done
        } >&2
    fi
fi

if [ -z "$addr" ]; then
    {
        echo "win-host-addr.sh: could not resolve the Windows QA host."
        echo "  COUCHCOOP_WIN_HOST_NAME = ${COUCHCOOP_WIN_HOST_NAME:-<unset>}"
        echo "  COUCHCOOP_WIN_HOST_MAC  = ${COUCHCOOP_WIN_HOST_MAC:-<unset>}"
        echo "  COUCHCOOP_WIN_HOST_ADDR = ${COUCHCOOP_WIN_HOST_ADDR:-<unset>}"
        echo "Set COUCHCOOP_WIN_HOST_ADDR to bypass discovery, or check the box is powered on."
    } >&2
    exit 1
fi

case "$mode" in
    print) printf '%s\n' "$addr" ;;
    check) printf '%s via %s\n' "$addr" "$via" ;;
    nc)
        if ! command -v nc >/dev/null 2>&1; then
            echo "win-host-addr.sh: nc not found, needed for --nc" >&2
            exit 1
        fi
        exec nc "$addr" "$port"
        ;;
esac

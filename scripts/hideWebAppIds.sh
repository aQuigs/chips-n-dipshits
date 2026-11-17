#!/usr/bin/env bash
# Runs a command with every web app id taken out of what it prints, and ends as the command did:
#   scripts/hideWebAppIds.sh npm run deploy -- --staging
#
# For a log anyone can read. A web app's address is its id, and the address is all that guards the lobby. The
# deploy and the check print the addresses they work on, and clasp prints the id of every web app the script has,
# one made in this very run among them: so the ids are taken out by their shape, not by a list of the known ones.
set -o pipefail

"$@" 2>&1 | sed -u -E 's/AKfycb[A-Za-z0-9_-]+/(a web app)/g'

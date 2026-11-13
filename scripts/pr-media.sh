#!/bin/zsh
# Shared script: sync-common keeps every repo's copy identical to the original in the tooling checkout; edit the original only.

# Uploads screenshots or recordings as GitHub attachments and prints the media block for the PR body.
# This is the same upload the web editor does on paste; the endpoint is undocumented but accepts the gh token.
# Images go two per row in an HTML table with a fixed <td width>, so a long caption wraps instead of widening its column.
# Usage: scripts/pr-media.sh <file> <caption> [<file> <caption>]...   (IMG_WIDTH sets the image width, default 300)

set -e

if (( $# == 0 || $# % 2 )); then
  echo "Usage: scripts/pr-media.sh <file> <caption> [<file> <caption>]..."
  exit 1
fi
IMG_WIDTH=${IMG_WIDTH:-300}
TOKEN=$(gh auth token)
REPO_ID=$(gh api 'repos/{owner}/{repo}' --jq .id)

CELLS=()
VIDEOS=()
for FILE CAPTION in "$@"; do
  if [[ ! -f $FILE ]]; then
    echo "No such file: $FILE"
    exit 1
  fi
  NAME=$(basename "$FILE")
  if [[ $NAME == *[^A-Za-z0-9._-]* ]]; then
    echo "File name '$NAME' may only contain letters, digits, dots, underscores, and dashes"
    exit 1
  fi
  MIME_TYPE=$(file -b --mime-type "$FILE")
  echo "Uploading $NAME ($MIME_TYPE)" >&2

  # Temporary workaround: replace this curl with `gh pr comment --attach` / `gh pr create --attach` once that flag ships in a stable gh release
  RESPONSE=$(curl -sS -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/json" \
    --data-binary "@$FILE" \
    "https://uploads.github.com/user-attachments/assets?name=$NAME&content_type=$MIME_TYPE&repository_id=$REPO_ID")
  URL=$(echo "$RESPONSE" | jq -r '.url // empty' 2>/dev/null || true)
  if [[ -z $URL ]]; then
    echo "Upload of $NAME failed, response was:"
    echo "$RESPONSE"
    exit 1
  fi

  case $NAME in
    *.png|*.jpg|*.jpeg|*.gif) CELLS+=("<td width=\"$IMG_WIDTH\" valign=\"top\"><img src=\"$URL\" alt=\"${NAME%.*}\" width=\"$IMG_WIDTH\"><br>$CAPTION</td>") ;;
    *) VIDEOS+=("$URL") ;;
  esac
done

if (( ${#CELLS} )); then
  echo "<table>"
  for LEFT RIGHT in "${CELLS[@]}"; do
    echo "<tr>$LEFT$RIGHT</tr>"
  done
  echo "</table>"
fi

# GitHub embeds a video only when its URL stands alone, after a blank line
for URL in "${VIDEOS[@]}"; do
  echo
  echo "$URL"
done

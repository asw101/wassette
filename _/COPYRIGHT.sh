#!/bin/bash

# This script adds a copyright notice to all .rs files in the repository
# that do not already have it.

# The copyright text to add is embedded in the script.
read -r -d '' COPYRIGHT_TEXT <<'EOF'
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
EOF

CHECK_STRING=$(echo "$COPYRIGHT_TEXT" | head -n 1)

# Use git ls-files to find all tracked .rs files, and also check untracked files.
# This is better than `find . -name "*.rs"` because it respects .gitignore,
# but we also want to cover files that are not yet tracked.
{ git ls-files -- '*.rs'; git ls-files --others --exclude-standard -- '*.rs'; } | while read -r file; do
    # Ensure the file exists and is a regular file
    if [ -f "$file" ]; then
        # Check if the file already contains the copyright string
        if ! grep -qF "$CHECK_STRING" "$file"; then
            echo "Adding copyright to $file"
            # Prepend the copyright text to the file
            # Using a temporary file to be safe
            TMPFILE=$(mktemp)
            echo "$COPYRIGHT_TEXT" > "$TMPFILE"
            echo "" >> "$TMPFILE"
            cat "$file" >> "$TMPFILE"
            mv "$TMPFILE" "$file"
        fi
    fi
done

echo "Copyright check and update complete."

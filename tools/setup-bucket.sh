#!/bin/sh
# Local MinIO bucket, matching the production R2 policy.
#
# Exactly one anonymous rule, which is the point of putting visibility first in
# the key: everything under public/ is readable (product images embedded in
# emailed PDFs, where a presigned URL would expire), and everything else --
# account documents, PIs, POs, decks -- is reachable only through a short-lived
# presigned URL.
#
# set-json REPLACES the whole policy. That matters: `mc anonymous set none` on
# the bucket root leaves rules attached to a prefix in place, so a stale grant
# from an earlier key layout would silently keep private objects readable.
set -e
ALIAS=local
BUCKET="${S3_BUCKET:-merchforce}"
mc alias set "$ALIAS" "${S3_ENDPOINT:-http://localhost:9000}" \
  "${S3_ACCESS_KEY_ID:-merchforce}" "${S3_SECRET_ACCESS_KEY:-merchforce123}" >/dev/null
mc mb --ignore-existing "$ALIAS/$BUCKET" >/dev/null
mc anonymous set-json /t/bucket-policy.json "$ALIAS/$BUCKET" >/dev/null
echo "bucket ready — anonymous rules now:"
mc anonymous list "$ALIAS/$BUCKET"

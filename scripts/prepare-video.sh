#!/bin/sh
# Prepare one example video for the site: H.264 + AAC, at most 720px wide, fast start (plays before it fully downloads),
# and a WebP poster from a chosen second. Usage: scripts/prepare-video.sh <input> <name> [poster_second]
# Writes assets/<name>.mp4 and assets/<name>-poster.webp and prints their size and duration.
set -eu
in="$1"; name="$2"; at="${3:-1}"
out="assets/$name.mp4"; poster="assets/$name-poster.webp"
ffmpeg -v error -y -i "$in" -vf "scale='min(720,iw)':-2" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -movflags +faststart "$out"
ffmpeg -v error -y -ss "$at" -i "$out" -frames:v 1 -vf "scale='min(720,iw)':-2" -quality 80 "$poster"
ffprobe -v error -show_entries stream=codec_type,width,height -show_entries format=duration,size -of compact "$out"
ls -la "$poster"

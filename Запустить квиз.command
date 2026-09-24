#!/bin/bash
# Двойной клик по этому файлу запускает квиз.
cd "$(dirname "$0")"
( sleep 1 && open "http://localhost:3000/host" ) &
node server.js

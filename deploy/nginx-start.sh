#!/bin/sh
set -eu
envsubst '${PUBLIC_HOST}' < /opt/clawd/nginx.conf.template > /var/run/nginx.conf
# Certbot and Nginx share certificate files, not the Docker socket.
# Reload periodically so a renewed certificate is served automatically.
(while sleep 6h; do nginx -c /var/run/nginx.conf -t && nginx -c /var/run/nginx.conf -s reload; done) &
exec nginx -c /var/run/nginx.conf -g 'daemon off;'

command -v lsof >/dev/null 2>&1 && echo LSOFOK=1 || echo LSOFOK=0
if ps ax -o pid=,command= >/dev/null 2>&1; then
  echo PSOK=1
  scan=$(ps ax -o pid=,command= 2>/dev/null | grep -E 'bin\.js +web' | grep -v grep | grep -E '^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*/)?node([0-9.]*)?[[:space:]]' | sed -E 's/^[[:space:]]*([0-9]+).*/\1/' | while read p; do uses=$(lsof -Fn -p $p 2>/dev/null | grep -c "^n__HOME__/"); echo "$p|$uses"; done)
else
  echo PSOK=0
  scan=
fi
echo "CANDIDATES=$(printf '%s\n' "$scan" | awk -F'|' '$1 ~ /^[0-9]+$/ && $2+0 > 0 {c++} END {print c+0}')"
targets=$(printf '%s\n' "$scan" | awk -F'|' -v keep=__KEEP__ '$1 ~ /^[0-9]+$/ && $2+0 > 0 && $1+0 != keep+0 {print $1}')
alive=$(printf '%s\n' "$targets" | while read p; do [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"; done)
echo "ALIVE=$(echo $alive)"
printf '%s\n' "$alive" | while read p; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
i=0
while [ $i -lt 10 ]; do
  left=$(printf '%s\n' "$alive" | while read p; do [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo x; done | wc -l | tr -d ' ')
  [ "$left" -eq 0 ] 2>/dev/null && break
  sleep 0.5
  i=$((i+1))
done
printf '%s\n' "$alive" | while read p; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null; done
sleep 0.5

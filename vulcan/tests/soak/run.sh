#!/bin/bash
# Out-of-process soak: real uvicorn server + separate speaker/prober clients over TCP.
# Usage: vulcan/tests/soak/run.sh <tree-root> <port> <messages> <background-chats>
# usage: run.sh <tree> <port> <messages> <bg-chats>
TREE=$1; PORT=$2; N=$3; BG=$4; D=$(dirname $0)
cd $D; rm -f probe-$PORT.log; touch probe-$PORT.log
python3 server.py $TREE $PORT $BG > server-$PORT.log 2>&1 & SP=$!
for i in $(seq 1 600); do python3 -c "import socket;socket.create_connection(('127.0.0.1',$PORT),1)" 2>/dev/null && break; sleep 1; done
python3 prober.py $TREE ws://127.0.0.1:$PORT/ws/general probe-$PORT.log & PP=$!
python3 speaker.py $TREE ws://127.0.0.1:$PORT/ws/general $N probe-$PORT.log
kill -USR1 $SP; sleep 2; kill $PP $SP 2>/dev/null; wait 2>/dev/null

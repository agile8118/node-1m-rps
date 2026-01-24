#!/bin/bash

# Use this script to setup, stop, or resume a local Redis Cluster.
# Usage: ./redis.sh -setup | -stop | -resume [-prod]
# Example: ./redis.sh -setup -prod

CMD=$1
SYSTEM=$2 # set to -prod for redis6-server else it will be redis-server

# Use the correct binary names for your machine

if [ "$SYSTEM" == "-prod" ]; then
  REDIS_SVR="redis6-server"
  REDIS_CLI="redis6-cli"
else 
  REDIS_SVR="redis-server"
  REDIS_CLI="redis-cli"
fi

if [ "$CMD" == "-setup" ]; then
  mkdir -p ../redis-cluster
  cd ../redis-cluster

  for port in $(seq 7000 7029); do
    mkdir -p $port
    cat <<EOF > $port/redis.conf
port $port
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 5000

# Disable persistence so that data is not saved to disk
save ""
appendonly no

protected-mode no
bind 127.0.0.1
maxclients 100000
EOF
    $REDIS_SVR ./$port/redis.conf --daemonize yes --dir ./$port
  done

  sleep 5

  $REDIS_CLI --cluster create \
  $(for port in $(seq 7000 7029); do echo -n "127.0.0.1:$port "; done) \
  --cluster-replicas 1 --cluster-yes

elif [ "$CMD" == "-stop" ]; then
  for port in $(seq 7000 7029); do
    $REDIS_CLI -p $port shutdown 2>/dev/null
  done
  sudo pkill -9 $REDIS_SVR 2>/dev/null

elif [ "$CMD" == "-resume" ]; then
  # Adjusted to point to the correct relative path
  for port in $(seq 7000 7029); do
    $REDIS_SVR ../redis-cluster/$port/redis.conf --daemonize yes --dir ../redis-cluster/$port
  done
else
  echo "Usage: ./redis.sh -setup | -stop | -resume"
fi
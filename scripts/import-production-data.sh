#!/bin/bash

echo "Starting mongodb";

mongod &

echo "Waiting...";

sleep 5s

echo "Importing production collections";

for collection in  "Applications" "Blockchains" "CronJobData" "LoadBalancers" "Nodes" "PaymentHistory" "PaymentMethods" "PendingTransactions" "Users" "NetworkData"; \
  do \
    echo "Importing $collection collection..."; \

    mongoimport --uri=$MONGO_DEST_CONNECTION --collection=$collection --type=json --file=/data/$collection \

    echo "Imported $collection collection successfully..."; \
done;

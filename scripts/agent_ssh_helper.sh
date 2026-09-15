#!/bin/bash

# Agent SSH Helper Script
# Usage: ./agent_ssh_helper.sh [TARGET_ID] <COMMAND>
# If TARGET_ID is omitted, defaults to 'vertikal'
# Example: ./agent_ssh_helper.sh "docker ps"
# Example: ./agent_ssh_helper.sh sock-shop "cat docker-compose.yml"

TARGET_ID=$1
CMD=$2

if [ -z "$CMD" ]; then
  # If only one argument is provided, treat it as the command and default to vertikal
  CMD=$TARGET_ID
  TARGET_ID="vertikal"
fi

if [ -z "$CMD" ]; then
  echo "Usage: $0 [TARGET_ID] <COMMAND>"
  exit 1
fi

CONFIG_FILE="$(dirname "$0")/../server/data/remote_config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Config file not found at $CONFIG_FILE"
  echo "Please save the AWS configuration in the Microservice Mapper UI first."
  exit 1
fi

IP=$(jq -r ".[\"$TARGET_ID\"].ec2PublicIp // empty" "$CONFIG_FILE")
KEY=$(jq -r ".[\"$TARGET_ID\"].sshKeyPath // empty" "$CONFIG_FILE")

if [ -z "$IP" ] || [ -z "$KEY" ]; then
  echo "Error: EC2 Public IP or SSH Key Path not found for target '$TARGET_ID' in $CONFIG_FILE"
  echo "Please save the AWS configuration in the Microservice Mapper UI first."
  exit 1
fi

# Expand tilde in key path if present
KEY="${KEY/#\~/$HOME}"

echo "Running command on $TARGET_ID ($IP) using key $KEY..."
ssh -i "$KEY" -o StrictHostKeyChecking=no ec2-user@"$IP" "$CMD"

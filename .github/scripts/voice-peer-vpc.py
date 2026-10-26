#!/usr/bin/env python3
"""Read-only deployment configuration: derive the exact VPC from the live service."""
import argparse
import ipaddress
import json
import subprocess


def aws(*args):
    result = subprocess.run(
        ["aws", *args, "--output", "json", "--no-cli-pager"],
        check=True, capture_output=True, text=True, timeout=30,
    )
    return json.loads(result.stdout)


def discover(cluster, service, read=aws):
    response = read("ecs", "describe-services", "--cluster", cluster, "--services", service)
    services = response.get("services", [])
    if response.get("failures") or len(services) != 1 or services[0].get("serviceName") != service:
        raise ValueError("Exact live service required")
    subnets = services[0].get("networkConfiguration", {}).get("awsvpcConfiguration", {}).get("subnets", [])
    if not subnets or len(set(subnets)) != len(subnets):
        raise ValueError("Exact service subnets required")
    rows = read("ec2", "describe-subnets", "--subnet-ids", *subnets).get("Subnets", [])
    if len(rows) != len(subnets) or {row.get("SubnetId") for row in rows} != set(subnets):
        raise ValueError("Incomplete subnet read")
    vpcs = {row.get("VpcId") for row in rows}
    if len(vpcs) != 1 or not next(iter(vpcs)):
        raise ValueError("Service subnets must share one VPC")
    vpc_id = next(iter(vpcs))
    subnet_rows = rows
    rows = read("ec2", "describe-vpcs", "--vpc-ids", vpc_id).get("Vpcs", [])
    if len(rows) != 1 or rows[0].get("VpcId") != vpc_id or rows[0].get("State") != "available":
        raise ValueError("Exact available VPC required")
    network = ipaddress.ip_network(rows[0].get("CidrBlock", ""), strict=True)
    private_ranges = [ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
    if network.version != 4 or not 16 <= network.prefixlen <= 28 or not any(network.subnet_of(value) for value in private_ranges):
        raise ValueError("Bounded private IPv4 VPC required")
    if any(not ipaddress.ip_network(row.get("CidrBlock", ""), strict=True).subnet_of(network) for row in subnet_rows):
        raise ValueError("Every service subnet must belong to the selected VPC CIDR")
    return str(network)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--service", required=True)
    args = parser.parse_args()
    print(discover(args.cluster, args.service))

import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("voice_peer_vpc", pathlib.Path(__file__).with_name("voice-peer-vpc.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VoicePeerVpc(unittest.TestCase):
    def run_discovery(self, *, subnet_rows=None, vpc=None, failures=None):
        responses = [
            {"failures": failures or [], "services": [{"serviceName": "alia", "networkConfiguration": {"awsvpcConfiguration": {"subnets": ["subnet-a", "subnet-b"]}}}]},
            {"Subnets": subnet_rows if subnet_rows is not None else [{"SubnetId": value, "VpcId": "vpc-own", "CidrBlock": f"10.20.{index}.0/24"} for index, value in enumerate(("subnet-a", "subnet-b"))]},
            {"Vpcs": [vpc or {"VpcId": "vpc-own", "State": "available", "CidrBlock": "10.20.0.0/16"}]},
        ]
        calls = []

        def read(*args):
            calls.append(args)
            return responses.pop(0)

        result = module.discover("oxy-cluster", "alia", read)
        self.assertEqual(calls, [
            ("ecs", "describe-services", "--cluster", "oxy-cluster", "--services", "alia"),
            ("ec2", "describe-subnets", "--subnet-ids", "subnet-a", "subnet-b"),
            ("ec2", "describe-vpcs", "--vpc-ids", "vpc-own"),
        ])
        return result

    def test_exact_live_network(self):
        self.assertEqual(self.run_discovery(), "10.20.0.0/16")

    def test_incomplete_or_foreign_subnets_fail(self):
        for rows in ([], [{"SubnetId": "subnet-a", "VpcId": "vpc-own"}], [
            {"SubnetId": "subnet-a", "VpcId": "vpc-own"}, {"SubnetId": "subnet-b", "VpcId": "vpc-foreign"},
        ]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.run_discovery(subnet_rows=rows)

    def test_missing_service_fails(self):
        with self.assertRaises(ValueError):
            self.run_discovery(failures=[{"reason": "MISSING"}])

    def test_subnet_in_secondary_network_cannot_silently_break_metadata_binding(self):
        with self.assertRaises(ValueError):
            self.run_discovery(subnet_rows=[
                {"SubnetId": "subnet-a", "VpcId": "vpc-own", "CidrBlock": "10.21.0.0/24"},
                {"SubnetId": "subnet-b", "VpcId": "vpc-own", "CidrBlock": "10.20.0.0/24"},
            ])

    def test_invalid_foreign_or_public_vpc_fails(self):
        for cidr in ("0.0.0.0/0", "8.8.0.0/16", "10.20.1.1/16", "::/0", "garbage"):
            with self.subTest(cidr=cidr), self.assertRaises(ValueError):
                self.run_discovery(vpc={"VpcId": "vpc-own", "State": "available", "CidrBlock": cidr})
        with self.assertRaises(ValueError):
            self.run_discovery(vpc={"VpcId": "vpc-other", "State": "available", "CidrBlock": "10.20.0.0/16"})


if __name__ == "__main__":
    unittest.main()

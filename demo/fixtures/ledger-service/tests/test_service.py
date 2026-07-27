import unittest

from ledger.service import allocate_request


class ServiceTests(unittest.TestCase):
    def test_normalizes_current_request_shape(self) -> None:
        result = allocate_request(
            {
                "total_cents": 10,
                "accounts": [{"account_id": "ops"}, {"account_id": "sales"}],
            }
        )
        self.assertEqual(10, sum(item["amount_cents"] for item in result["allocations"]))

    def test_rejects_invalid_account(self) -> None:
        with self.assertRaisesRegex(ValueError, "account_id"):
            allocate_request({"total_cents": 10, "accounts": [{}]})


if __name__ == "__main__":
    unittest.main()

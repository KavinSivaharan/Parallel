import unittest

from ledger.allocation import allocate_cents


class AllocationTests(unittest.TestCase):
    def test_even_allocation(self) -> None:
        result = allocate_cents(900, ["ops", "sales", "research"])
        self.assertEqual([300, 300, 300], [item["amount_cents"] for item in result])

    def test_preserves_every_cent_when_total_has_remainder(self) -> None:
        result = allocate_cents(100, ["ops", "sales", "research"])
        self.assertEqual(100, sum(int(item["amount_cents"]) for item in result))
        self.assertLessEqual(
            max(int(item["amount_cents"]) for item in result)
            - min(int(item["amount_cents"]) for item in result),
            1,
        )

    def test_rejects_duplicate_accounts(self) -> None:
        with self.assertRaisesRegex(ValueError, "unique"):
            allocate_cents(100, ["ops", "ops"])


if __name__ == "__main__":
    unittest.main()

import unittest

from domain import calculate_invoice_summary, format_kes_minor


class InvoiceCalculationTests(unittest.TestCase):
    def test_calculates_subtotal_using_integer_minor_units(self):
        result = calculate_invoice_summary([
            {"description": "Washroom cleaning", "quantity_milli": 2000, "unit_price_minor": 125050},
            {"description": "Window cleaning", "quantity_milli": 1000, "unit_price_minor": 80000},
        ])

        self.assertEqual(result["subtotal_minor"], 330100)
        self.assertEqual(result["tax_minor"], 0)
        self.assertEqual(result["total_minor"], 330100)
        self.assertEqual(result["lines"][0]["line_total_minor"], 250100)

    def test_rounds_half_up_for_fractional_quantities(self):
        result = calculate_invoice_summary([
            {"description": "Supplies", "quantity_milli": 500, "unit_price_minor": 10001},
        ])

        self.assertEqual(result["lines"][0]["line_total_minor"], 5001)

    def test_rejects_empty_invoice(self):
        with self.assertRaisesRegex(ValueError, "at least one line"):
            calculate_invoice_summary([])

    def test_rejects_negative_or_non_integer_values(self):
        invalid_lines = [
            {"description": "Bad quantity", "quantity_milli": -1000, "unit_price_minor": 100},
            {"description": "Bad price", "quantity_milli": 1000, "unit_price_minor": -100},
            {"description": "Float quantity", "quantity_milli": 1.5, "unit_price_minor": 100},
        ]
        for line in invalid_lines:
            with self.subTest(line=line), self.assertRaises(ValueError):
                calculate_invoice_summary([line])

    def test_formats_kenyan_shillings_without_float_rounding(self):
        self.assertEqual(format_kes_minor(125050), "KSh 1,250.50")
        self.assertEqual(format_kes_minor(0), "KSh 0.00")


if __name__ == "__main__":
    unittest.main()

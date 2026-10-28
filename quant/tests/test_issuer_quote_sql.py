"""Optional read-only PostgreSQL integration of actual issuer query variants."""

import json
import os
import unittest

import certifi
import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

from data.online_inputs import QUERIES

FIXTURES = """WITH h(bond_code,valuation_date,chinabond_yield_pct,remaining_term_years,outstanding_balance_cny) AS
(VALUES
('A1.SH','2026-01-05'::date,1.5::float8,1.0::float8,100::float8),
('A2.SH','2026-01-05'::date,1.7,3.0,100),('A3.SH','2026-01-05'::date,NULL,10.0,100),
('B1.SH','2026-01-05'::date,1.6,2.0,100),
('C1.SH','2026-01-05'::date,1.6,2.0,100),('C2.SH','2026-01-05'::date,1.8,2.0,100),
('D1.SH','2026-01-05'::date,1.5,1.0,100),('D2.SH','2026-01-05'::date,1.7,3.0,100),
('D3.SH','2026-01-05'::date,5.0,20.0,-1),('D4.SH','2026-01-05'::date,NULL,100.0,100),
('D5.SH','2026-01-05'::date,8.0,200.0,0),('D6.SH','2026-01-05'::date,9.0,300.0,NULL),
('D7.SH','2026-01-05'::date,7.0,NULL,100),('E1.SH','2026-01-05'::date,NULL,NULL,100)),
i(bond_code,issuer_name,bond_type,placement_type,interest_rate_type,has_option) AS
(SELECT bond_code,substring(bond_code,1,1),'证券公司债','公募','固息',CASE WHEN bond_code LIKE 'D%' THEN true WHEN bond_code LIKE 'E%' THEN NULL::boolean ELSE false END FROM h)
"""


def fixture_query(sql):
    source = (
        "FROM public.bond_history h JOIN public.bond_issuance i "
        "ON h.bond_code=public.exchange_bond_code(i.bond_code)"
    )
    if sql.count(source) != 1:
        raise ValueError("fixture must replace exactly one source")
    sql = sql.replace(source, "FROM h JOIN i ON h.bond_code=i.bond_code")
    sql = sql.replace("$1", "'2026-01-06'").replace("$2", "'2026-01-01'")
    return (
        FIXTURES.rstrip() + ", " + sql[5:]
        if sql.startswith("WITH ")
        else FIXTURES + sql
    )


@unittest.skipUnless(
    os.environ.get("QUANT_DATABASE_TESTS") == "1", "explicit read-only database test"
)
class IssuerQuoteSQLTests(unittest.TestCase):
    def test_complete_pairs_bounds_degenerate_fits_and_legacy_aggregates(self):
        load_dotenv()
        variants = []
        with psycopg.connect(
            os.environ["DATABASE_URL"],
            sslrootcert=certifi.where(),
            row_factory=dict_row,
            connect_timeout=15,
        ) as connection:
            connection.execute("SET TRANSACTION READ ONLY")
            connection.execute("SET LOCAL statement_timeout = '30000ms'")
            for name in ("issuer_daily", "issuer_daily_live", "issuer_daily_rows"):
                with self.subTest(query=name):
                    rows = connection.execute(fixture_query(QUERIES[name])).fetchall()
                    if rows and "payload" in rows[0]:
                        rows = json.loads(rows[0]["payload"])
                    keys = ("date", "issuer", "bond_type", "placement_type")
                    indexed = {tuple(row[k] for k in keys): row for row in rows}
                    self.assertEqual(len(indexed), len(rows))
                    self.assertEqual(len(rows), 5)
                    variants.append(indexed)
                    cases = {r["issuer"]: r for r in rows}
                    for issuer in ("A", "D"):
                        r = cases[issuer]
                        self.assertAlmostEqual(r["yield_slope"], 0.1)
                        self.assertAlmostEqual(r["yield_intercept"], 1.4)
                        self.assertEqual(r["fit_observations"], 2)
                        self.assertEqual((r["min_tenor"], r["max_tenor"]), (1, 3))
                        self.assertIsNone(r["yield_percent"])
                        self.assertIsNone(r["tenor_years"])
                    for issuer, fitted in (("B", 1), ("C", 2)):
                        r = cases[issuer]
                        self.assertIsNone(r["yield_slope"])
                        self.assertIsNone(r["yield_intercept"])
                        self.assertEqual(r["fit_observations"], fitted)
                    self.assertEqual(cases["B"]["yield_percent"], 1.6)
                    self.assertAlmostEqual(cases["C"]["yield_percent"], 1.7)
                    self.assertEqual(cases["A"]["balance_cny"], 300)
                    self.assertEqual(cases["D"]["balance_cny"], 400)
                    self.assertEqual(cases["D"]["observations"], 4)
                    self.assertEqual(cases["D"]["missing_observations"], 3)
                    self.assertEqual(cases["E"]["fit_observations"], 0)
                    self.assertIsNone(cases["E"]["min_tenor"])
                    self.assertIsNone(cases["E"]["max_tenor"])
        self.assertEqual(variants[0], variants[1])
        self.assertEqual(variants[0], variants[2])

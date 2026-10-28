"""发行交易日与调休工作日报价日分别处理；不猜测未公布年份。"""

import pandas as pd


CALENDAR_2026 = {
    "year": 2026,
    "issuance_source": "https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml",
    "workday_source": "https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html",
    "closures": (
        ("01-01", "01-03"),
        ("02-15", "02-23"),
        ("04-04", "04-06"),
        ("05-01", "05-05"),
        ("06-19", "06-21"),
        ("09-25", "09-27"),
        ("10-01", "10-07"),
    ),
    "makeup_workdays": ("01-04", "02-14", "02-28", "05-09", "09-20", "10-10"),
}


class IssuanceCalendar:
    def __init__(self, specification=None):
        self.specification = specification or CALENDAR_2026
        year = self.specification["year"]
        self.year = year
        self.closed = set()
        for start, end in self.specification["closures"]:
            self.closed.update(pd.date_range(f"{year}-{start}", f"{year}-{end}"))
        self.makeup = {
            pd.Timestamp(f"{year}-{day}")
            for day in self.specification["makeup_workdays"]
        }

    def _date(self, value):
        date = pd.Timestamp(value).normalize()
        if date.year != self.year:
            raise ValueError(f"缺少 {date.year} 年已核实的交易所日历")
        return date

    def is_issuance_day(self, value):
        date = self._date(value)
        return date.weekday() < 5 and date not in self.closed

    def is_quote_workday(self, value):
        date = self._date(value)
        return self.is_issuance_day(date) or date in self.makeup

    def issuance_dates(self, start, end):
        dates = pd.date_range(self._date(start), self._date(end))
        return pd.DatetimeIndex([date for date in dates if self.is_issuance_day(date)])

    def previous_quote_day(self, as_of):
        date = self._date(as_of) - pd.Timedelta(days=1)
        while not self.is_quote_workday(date):
            date -= pd.Timedelta(days=1)
        return date

    def quote_dates(self, start, end):
        dates = pd.date_range(self._date(start), self._date(end))
        return pd.DatetimeIndex([date for date in dates if self.is_quote_workday(date)])

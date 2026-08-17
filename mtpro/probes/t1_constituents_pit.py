import os, json
from pathlib import Path
env = Path(r"D:\vivecoding\test project_0613\.env.local")
for line in env.read_text(encoding="utf-8").splitlines():
    if line.startswith(("KRX_ID=", "KRX_PW=")):
        k, v = line.split("=", 1); os.environ[k] = v.strip().strip('"').strip("'")
from pykrx import stock
a=set(stock.get_index_portfolio_deposit_file("1028","20230103")); b=set(stock.get_index_portfolio_deposit_file("1028","20260814"))
c=set(stock.get_index_portfolio_deposit_file("1028","20220103"))
print(json.dumps({"n_20220103":len(c),"n_20230103":len(a),"n_20260814":len(b),"only_2023":len(a-b),"only_now":len(b-a),"common":len(a&b),"only_2022_vs_now":len(c-b)},ensure_ascii=False))

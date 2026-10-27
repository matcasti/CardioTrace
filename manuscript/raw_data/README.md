# Data for Figure 3 and Table 3

Anonymized RR-interval series from a single adult volunteer wearing two Polar H10 chest straps at the same time, one paired to EliteHRV and one to CardioTrace.

| File | Content |
|---|---|
| `cardiotrace.txt` | RR intervals in ms exported by CardioTrace (one value per line, 3 decimals, 1/1024 s resolution). The first 13 lines precede the start of the EliteHRV recording and are discarded for the comparison [AUTHORS: confirm the reason]; lines 14–996 are the 983 paired intervals. |
| `elitehrv.txt` | RR intervals in ms exported by EliteHRV (integer milliseconds, one value per line, CRLF line endings), 983 values. |
| `prep-data.R` | Aligns the two series, computes R², RMSE, MAPE, bias and 95 % limits of agreement, and writes `../figure-3.png`. |

Recording duration 10.4 min, mean RR 634.5 ms. No identifying information is included.

**License of the data:** [AUTHORS: confirm; CC BY 4.0 or CC0 is recommended by MDPI for data repositories.]
Code in this repository is released under the MIT License.

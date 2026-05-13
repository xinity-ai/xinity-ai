# Benchmark Report — chat

- **run_id**: `2026-05-09T12-18-49Z__chat__qwen3.6-35b-a3b-fp8`
- **model**: `qwen3.6-35b-a3b-fp8`
- **base_url host**: `dev-api.xinity.ai`
- **started**: 2026-05-09T12:18:49.930Z  →  2026-05-10T15:06:00.528Z
- **bun**: 1.3.1, **platform**: linux, **cpus**: 12, **mem**: 57MB
- **git**: `c84e7ff15e5867372ccf05d40fe3d678a2c0181d`

## Preflight
- reachable: true, smoke: true
- context probe: ≥ 262144 ok, < 524288 fails (tried 8192, 32768, 131072, 262144, 524288)
- cache probe: first 279.9ms, second 254.9ms (ratio 0.91)

## Rollup
- scenarios: 103 done, 0 skipped, 17 degraded, 0 aborted (total 120)
- requests: 19242 ok / 31200 (11958 failed)

## Scenarios

| scenario | conc | params | n / ok | ttft p50/p95 (ms) | tps p50/p95 | wall p50/p95 (ms) | agg out tps | eff conc | err | status |
| --- | ---: | --- | ---: | --- | --- | --- | ---: | ---: | --- | --- |
| chat__in-tiny__out-short__c1 | 1 | in=tiny out=short (256t / 64t) | 32/32 | 321.0 / 511.9 | 35.5 / 47.9 | 1032.4 / 1359.0 | 23.4 | 1.00 | — | done |
| chat__in-tiny__out-short__c4 | 4 | in=tiny out=short (256t / 64t) | 32/32 | 402.7 / 4921.3 | 22.0 / 27.9 | 1561.4 / 5720.8 | 46.1 | 3.89 | — | done |
| chat__in-tiny__out-short__c8 | 8 | in=tiny out=short (256t / 64t) | 32/32 | 526.9 / 886.9 | 16.5 / 24.4 | 2212.6 / 2883.0 | 90.0 | 7.67 | — | done |
| chat__in-tiny__out-short__c32 | 32 | in=tiny out=short (256t / 64t) | 64/64 | 2047.8 / 3951.0 | 9.7 / 16.0 | 4374.2 / 6459.5 | 152.6 | 28.30 | — | done |
| chat__in-tiny__out-short__c64 | 64 | in=tiny out=short (256t / 64t) | 128/128 | 6747.3 / 7641.7 | 9.1 / 15.0 | 9238.3 / 11046.8 | 160.3 | 52.77 | — | done |
| chat__in-tiny__out-short__c128 | 128 | in=tiny out=short (256t / 64t) | 256/256 | 17120.3 / 17953.7 | 8.5 / 12.4 | 19434.3 / 21767.5 | 155.3 | 101.03 | — | done |
| chat__in-tiny__out-short__c256 | 256 | in=tiny out=short (256t / 64t) | 512/512 | 36476.0 / 37483.2 | 8.7 / 12.0 | 38719.6 / 41056.7 | 158.9 | 197.36 | — | done |
| chat__in-tiny__out-short__c512 | 512 | in=tiny out=short (256t / 64t) | 1024/1024 | 75735.5 / 77069.1 | 8.6 / 11.7 | 78090.4 / 80472.9 | 158.3 | 388.38 | — | done |
| chat__in-tiny__out-medium__c1 | 1 | in=tiny out=medium (256t / 512t) | 32/32 | 303.9 / 451.5 | 45.6 / 49.8 | 11430.9 / 12337.1 | 44.5 | 1.00 | — | done |
| chat__in-tiny__out-medium__c4 | 4 | in=tiny out=medium (256t / 512t) | 32/32 | 390.7 / 1536.4 | 30.9 / 34.7 | 17058.4 / 18080.5 | 119.3 | 3.93 | — | done |
| chat__in-tiny__out-medium__c8 | 8 | in=tiny out=medium (256t / 512t) | 32/32 | 492.2 / 1566.9 | 24.3 / 26.8 | 21528.0 / 23657.1 | 184.1 | 7.79 | — | done |
| chat__in-tiny__out-medium__c32 | 32 | in=tiny out=medium (256t / 512t) | 64/64 | 4624.6 / 33030.2 | 15.7 / 17.4 | 37137.3 / 66111.5 | 315.2 | 27.30 | — | done |
| chat__in-tiny__out-medium__c64 | 64 | in=tiny out=medium (256t / 512t) | 128/128 | 66843.6 / 69835.3 | 15.2 / 17.7 | 97283.2 / 104886.2 | 318.3 | 51.86 | — | done |
| chat__in-tiny__out-medium__c128 | 128 | in=tiny out=medium (256t / 512t) | 128/256 | 73384.3 / 318933.4 | 15.1 / 18.7 | 108945.6 / 347731.5 | 75.5 | 95.55 | timeout:128 | degraded (128/256 failed) |
| chat__in-tiny__out-medium__c256 | 256 | in=tiny out=medium (256t / 512t) | 88/512 | 51417.5 / 107232.5 | 15.0 / 16.9 | 85904.2 / 141901.3 | 46.5 | 219.78 | timeout:424 | degraded (424/512 failed) |
| chat__in-tiny__out-medium__c512 | 512 | in=tiny out=medium (256t / 512t) | 143/1024 | 101110.4 / 468242.6 | 15.0 / 16.7 | 135119.4 / 501971.2 | 73.1 | 304.47 | network:537 timeout:344 | degraded (881/1024 failed) |
| chat__in-tiny__out-long__c1 | 1 | in=tiny out=long (256t / 2048t) | 32/32 | 308.8 / 511.3 | 49.9 / 55.4 | 36728.8 / 42496.1 | 50.0 | 1.00 | — | done |
| chat__in-tiny__out-long__c4 | 4 | in=tiny out=long (256t / 2048t) | 32/32 | 402.1 / 1226.6 | 35.0 / 38.0 | 55180.2 / 60315.6 | 136.1 | 3.92 | — | done |
| chat__in-tiny__out-long__c8 | 8 | in=tiny out=long (256t / 2048t) | 32/32 | 509.7 / 1011.4 | 26.3 / 29.1 | 69317.2 / 80892.1 | 200.9 | 7.62 | — | done |
| chat__in-tiny__out-long__c32 | 32 | in=tiny out=long (256t / 2048t) | 64/64 | 20343.4 / 115298.4 | 16.4 / 17.6 | 142694.2 / 237372.0 | 318.9 | 27.13 | — | done |
| chat__in-tiny__out-long__c64 | 64 | in=tiny out=long (256t / 2048t) | 128/128 | 163558.2 / 420108.5 | 16.8 / 22.8 | 282189.1 / 540320.1 | 340.2 | 50.86 | — | done |
| chat__in-tiny__out-long__c128 | 128 | in=tiny out=long (256t / 2048t) | 218/256 | 185225.2 / 780922.3 | 18.4 / 23.9 | 300057.7 / 874005.5 | 342.6 | 104.10 | timeout:38 | done |
| chat__in-tiny__out-long__c256 | 256 | in=tiny out=long (256t / 2048t) | 307/512 | 217638.1 / 901053.6 | 17.7 / 23.6 | 300067.6 / 1018906.5 | 327.1 | 180.81 | timeout:205 | done |
| chat__in-tiny__out-long__c512 | 512 | in=tiny out=long (256t / 2048t) | 141/1024 | 230977.9 / 933037.6 | 16.8 / 24.5 | 300321.0 / 1021753.3 | 156.2 | 374.13 | network:404 timeout:479 | degraded (883/1024 failed) |
| chat__in-small__out-short__c1 | 1 | in=small out=short (1024t / 64t) | 32/32 | 511.5 / 717.5 | 28.2 / 41.8 | 1405.1 / 1746.3 | 17.3 | 1.00 | — | done |
| chat__in-small__out-short__c4 | 4 | in=small out=short (1024t / 64t) | 32/32 | 636.0 / 924.7 | 20.4 / 30.7 | 1759.5 / 2526.6 | 50.8 | 3.93 | — | done |
| chat__in-small__out-short__c8 | 8 | in=small out=short (1024t / 64t) | 32/32 | 846.5 / 1469.3 | 14.8 / 27.0 | 2312.7 / 3426.5 | 70.5 | 7.49 | — | done |
| chat__in-small__out-short__c32 | 32 | in=small out=short (1024t / 64t) | 64/64 | 3048.8 / 6333.0 | 6.5 / 19.6 | 6571.9 / 10604.5 | 102.3 | 28.97 | — | done |
| chat__in-small__out-short__c64 | 64 | in=small out=short (1024t / 64t) | 128/128 | 10320.7 / 13434.6 | 6.1 / 11.2 | 13805.0 / 17632.6 | 102.5 | 54.29 | — | done |
| chat__in-small__out-short__c128 | 128 | in=small out=short (1024t / 64t) | 256/256 | 24237.4 / 25568.6 | 6.2 / 8.7 | 27600.4 / 30316.0 | 106.6 | 102.24 | — | done |
| chat__in-small__out-short__c256 | 256 | in=small out=short (1024t / 64t) | 512/512 | 53389.2 / 55149.2 | 6.1 / 8.1 | 56756.2 / 59842.7 | 107.8 | 199.09 | — | done |
| chat__in-small__out-short__c512 | 512 | in=small out=short (1024t / 64t) | 1024/1024 | 110760.4 / 112006.1 | 5.9 / 8.0 | 113673.5 / 116929.5 | 107.0 | 390.59 | — | done |
| chat__in-small__out-medium__c1 | 1 | in=small out=medium (1024t / 512t) | 32/32 | 441.8 / 620.9 | 45.6 / 51.0 | 11571.8 / 12627.7 | 43.7 | 1.00 | — | done |
| chat__in-small__out-medium__c4 | 4 | in=small out=medium (1024t / 512t) | 32/32 | 453.7 / 1124.6 | 31.4 / 37.7 | 16581.9 / 18262.8 | 120.5 | 3.90 | — | done |
| chat__in-small__out-medium__c8 | 8 | in=small out=medium (1024t / 512t) | 32/32 | 585.4 / 1531.7 | 23.9 / 26.6 | 21999.9 / 25078.7 | 180.8 | 7.87 | — | done |
| chat__in-small__out-medium__c32 | 32 | in=small out=medium (1024t / 512t) | 64/64 | 6202.7 / 36605.4 | 14.3 / 16.4 | 41437.0 / 74917.5 | 272.4 | 26.77 | — | done |
| chat__in-small__out-medium__c64 | 64 | in=small out=medium (1024t / 512t) | 128/128 | 73982.2 / 79172.3 | 14.2 / 16.0 | 108213.2 / 117823.0 | 279.4 | 51.23 | — | done |
| chat__in-small__out-medium__c128 | 128 | in=small out=medium (1024t / 512t) | 128/256 | 93995.0 / 411519.5 | 14.0 / 17.8 | 139346.8 / 441083.1 | 70.4 | 94.24 | timeout:128 | degraded (128/256 failed) |
| chat__in-small__out-medium__c256 | 256 | in=small out=medium (1024t / 512t) | 85/512 | 50012.6 / 115431.3 | 14.1 / 16.8 | 91330.3 / 152161.4 | 44.9 | 221.62 | timeout:427 | degraded (427/512 failed) |
| chat__in-small__out-medium__c512 | 512 | in=small out=medium (1024t / 512t) | 89/1024 | 70850.1 / 118899.9 | 14.2 / 16.0 | 106773.1 / 160446.9 | 66.3 | 291.10 | network:709 timeout:226 | degraded (935/1024 failed) |
| chat__in-small__out-long__c1 | 1 | in=small out=long (1024t / 2048t) | 32/32 | 408.4 / 570.4 | 51.4 / 56.1 | 37354.7 / 41434.0 | 50.6 | 1.00 | — | done |
| chat__in-small__out-long__c4 | 4 | in=small out=long (1024t / 2048t) | 32/32 | 464.6 / 799.2 | 34.7 / 41.2 | 54918.4 / 62973.9 | 133.0 | 3.81 | — | done |
| chat__in-small__out-long__c8 | 8 | in=small out=long (1024t / 2048t) | 32/32 | 575.6 / 1411.7 | 26.4 / 28.5 | 72148.2 / 81711.0 | 198.2 | 7.59 | — | done |
| chat__in-small__out-long__c32 | 32 | in=small out=long (1024t / 2048t) | 64/64 | 33182.3 / 118605.2 | 15.8 / 20.3 | 157066.4 / 236082.2 | 291.4 | 26.35 | — | done |
| chat__in-small__out-long__c64 | 64 | in=small out=long (1024t / 2048t) | 128/128 | 179982.6 / 416116.7 | 18.3 / 24.7 | 294805.5 / 524967.6 | 352.1 | 51.56 | — | done |
| chat__in-small__out-long__c128 | 128 | in=small out=long (1024t / 2048t) | 217/256 | 184519.9 / 901854.2 | 17.4 / 23.6 | 300059.5 / 1021344.7 | 339.5 | 101.09 | timeout:39 | done |
| chat__in-small__out-long__c256 | 256 | in=small out=long (1024t / 2048t) | 305/512 | 413906.9 / 911877.2 | 18.0 / 23.9 | 540288.3 / 1021234.7 | 297.7 | 184.35 | network:1 timeout:206 | done |
| chat__in-small__out-long__c512 | 512 | in=small out=long (1024t / 2048t) | 126/1024 | 225249.0 / 897056.5 | 17.6 / 23.9 | 300578.9 / 1020645.6 | 142.9 | 402.69 | timeout:651 network:247 | degraded (898/1024 failed) |
| chat__in-medium__out-short__c1 | 1 | in=medium out=short (4096t / 64t) | 32/32 | 1021.7 / 1275.2 | 36.8 / 64.2 | 1736.8 / 2037.0 | 14.5 | 1.00 | — | done |
| chat__in-medium__out-short__c4 | 4 | in=medium out=short (4096t / 64t) | 32/32 | 1783.0 / 2454.9 | 17.3 / 29.9 | 3120.9 / 3459.8 | 28.9 | 3.99 | — | done |
| chat__in-medium__out-short__c8 | 8 | in=medium out=short (4096t / 64t) | 32/32 | 1799.6 / 4277.7 | 7.6 / 20.1 | 5093.3 / 7792.4 | 36.0 | 7.85 | — | done |
| chat__in-medium__out-short__c32 | 32 | in=medium out=short (4096t / 64t) | 64/64 | 13576.8 / 17452.8 | 4.9 / 8.4 | 18030.6 / 24049.6 | 40.4 | 27.25 | — | done |
| chat__in-medium__out-short__c64 | 64 | in=medium out=short (4096t / 64t) | 128/128 | 32505.8 / 35323.3 | 4.9 / 6.9 | 36731.2 / 40794.5 | 39.9 | 52.10 | — | done |
| chat__in-medium__out-short__c128 | 128 | in=medium out=short (4096t / 64t) | 256/256 | 70538.7 / 72255.0 | 4.8 / 6.3 | 74247.3 / 78844.2 | 39.6 | 99.90 | — | done |
| chat__in-medium__out-short__c256 | 256 | in=medium out=short (4096t / 64t) | 512/512 | 118609.6 / 446542.6 | 4.8 / 6.2 | 123208.3 / 451614.7 | 24.9 | 207.37 | — | done |
| chat__in-medium__out-short__c512 | 512 | in=medium out=short (4096t / 64t) | 294/1024 | 88350.9 / 459515.1 | 4.8 / 6.1 | 93856.2 / 463632.4 | 14.3 | 330.59 | network:692 timeout:38 | degraded (730/1024 failed) |
| chat__in-medium__out-medium__c1 | 1 | in=medium out=medium (4096t / 512t) | 32/32 | 1030.2 / 1266.7 | 44.5 / 50.5 | 12514.3 / 13269.4 | 41.0 | 1.00 | — | done |
| chat__in-medium__out-medium__c4 | 4 | in=medium out=medium (4096t / 512t) | 32/32 | 961.7 / 2138.6 | 29.5 / 37.3 | 18261.3 / 21055.1 | 108.7 | 3.89 | — | done |
| chat__in-medium__out-medium__c8 | 8 | in=medium out=medium (4096t / 512t) | 32/32 | 1381.0 / 4585.2 | 21.1 / 25.2 | 25697.2 / 29792.4 | 154.8 | 7.85 | — | done |
| chat__in-medium__out-medium__c32 | 32 | in=medium out=medium (4096t / 512t) | 64/64 | 34721.1 / 52070.0 | 11.9 / 20.8 | 63112.0 / 97513.0 | 199.7 | 27.15 | — | done |
| chat__in-medium__out-medium__c64 | 64 | in=medium out=medium (4096t / 512t) | 128/128 | 93437.9 / 200684.4 | 11.9 / 15.1 | 136320.5 / 233331.4 | 198.0 | 50.31 | — | done |
| chat__in-medium__out-medium__c128 | 128 | in=medium out=medium (4096t / 512t) | 61/256 | 53103.0 / 477452.6 | 11.7 / 13.9 | 95865.4 / 514831.6 | 30.5 | 100.62 | timeout:195 | degraded (195/256 failed) |
| chat__in-medium__out-medium__c256 | 256 | in=medium out=medium (4096t / 512t) | 57/512 | 50980.4 / 101930.0 | 11.5 / 14.7 | 94609.6 / 146125.0 | 30.0 | 233.01 | timeout:455 | degraded (455/512 failed) |
| chat__in-medium__out-medium__c512 | 512 | in=medium out=medium (4096t / 512t) | 61/1024 | 52305.7 / 392626.9 | 11.7 / 16.9 | 94927.5 / 416955.4 | 45.2 | 284.49 | network:732 timeout:231 | degraded (963/1024 failed) |
| chat__in-medium__out-long__c1 | 1 | in=medium out=long (4096t / 2048t) | 32/32 | 1128.1 / 1356.2 | 49.3 / 60.4 | 40106.7 / 44112.1 | 48.8 | 1.00 | — | done |
| chat__in-medium__out-long__c4 | 4 | in=medium out=long (4096t / 2048t) | 32/32 | 934.8 / 2099.9 | 32.8 / 39.5 | 57416.4 / 65008.3 | 129.9 | 3.96 | — | done |
| chat__in-medium__out-long__c8 | 8 | in=medium out=long (4096t / 2048t) | 32/32 | 1092.0 / 4375.9 | 24.0 / 28.5 | 78418.2 / 91742.4 | 183.6 | 7.69 | — | done |
| chat__in-medium__out-long__c32 | 32 | in=medium out=long (4096t / 2048t) | 64/64 | 112636.7 / 136466.4 | 14.3 / 18.4 | 224047.8 / 280485.7 | 238.7 | 26.72 | — | done |
| chat__in-medium__out-long__c64 | 64 | in=medium out=long (4096t / 2048t) | 128/128 | 155753.1 / 669270.7 | 15.7 / 21.3 | 294969.8 / 780516.0 | 268.2 | 51.43 | — | done |
| chat__in-medium__out-long__c128 | 128 | in=medium out=long (4096t / 2048t) | 199/256 | 225182.8 / 784508.0 | 17.9 / 21.6 | 300110.5 / 881834.9 | 262.0 | 100.62 | network:2 timeout:55 | done |
| chat__in-medium__out-long__c256 | 256 | in=medium out=long (4096t / 2048t) | 241/512 | 312306.9 / 925774.4 | 15.9 / 21.5 | 447540.5 / 1021250.8 | 236.9 | 193.50 | timeout:271 | degraded (271/512 failed) |
| chat__in-medium__out-long__c512 | 512 | in=medium out=long (4096t / 2048t) | 103/1024 | 419599.9 / 698774.3 | 16.7 / 22.8 | 540860.0 / 781584.4 | 116.3 | 388.77 | network:24 timeout:897 | degraded (921/1024 failed) |
| chat__in-large__out-short__c1 | 1 | in=large out=short (16384t / 64t) | 32/32 | 2955.2 / 3372.8 | 34.0 / 49.6 | 3685.5 / 4998.8 | 6.7 | 1.00 | — | done |
| chat__in-large__out-short__c4 | 4 | in=large out=short (16384t / 64t) | 32/32 | 4833.1 / 8309.0 | 5.2 / 16.1 | 8793.1 / 12125.4 | 9.9 | 3.91 | — | done |
| chat__in-large__out-short__c8 | 8 | in=large out=short (16384t / 64t) | 32/32 | 13257.9 / 15540.6 | 5.3 / 9.9 | 17153.0 / 20882.9 | 10.3 | 7.50 | — | done |
| chat__in-large__out-short__c32 | 32 | in=large out=short (16384t / 64t) | 64/64 | 65119.9 / 67260.6 | 5.0 / 6.4 | 69265.8 / 73194.2 | 10.8 | 25.24 | — | done |
| chat__in-large__out-short__c64 | 64 | in=large out=short (16384t / 64t) | 128/128 | 136092.3 / 139149.8 | 4.9 / 6.4 | 140186.5 / 145061.5 | 11.0 | 49.32 | — | done |
| chat__in-large__out-short__c128 | 128 | in=large out=short (16384t / 64t) | 256/256 | 237212.6 / 619959.8 | 4.8 / 6.3 | 242069.7 / 624781.3 | 9.4 | 97.59 | — | done |
| chat__in-large__out-short__c256 | 256 | in=large out=short (16384t / 64t) | 357/512 | 237883.6 / 714883.4 | 4.9 / 6.3 | 242776.0 / 718872.1 | 7.4 | 211.59 | timeout:145 network:10 | done |
| chat__in-large__out-short__c512 | 512 | in=large out=short (16384t / 64t) | 311/1024 | 412922.7 / 925300.4 | 4.9 / 6.4 | 417080.8 / 929188.1 | 3.8 | 375.75 | network:33 timeout:680 | degraded (713/1024 failed) |
| chat__in-large__out-medium__c1 | 1 | in=large out=medium (16384t / 512t) | 32/32 | 2774.1 / 3111.0 | 40.4 / 42.1 | 15308.5 / 15999.1 | 32.7 | 1.00 | — | done |
| chat__in-large__out-medium__c4 | 4 | in=large out=medium (16384t / 512t) | 32/32 | 3215.2 / 6378.2 | 22.0 / 27.4 | 26593.2 / 31517.4 | 73.8 | 3.95 | — | done |
| chat__in-large__out-medium__c8 | 8 | in=large out=medium (16384t / 512t) | 32/32 | 4855.9 / 15454.1 | 13.7 / 18.9 | 41521.1 / 50480.3 | 95.5 | 7.87 | — | done |
| chat__in-large__out-medium__c32 | 32 | in=large out=medium (16384t / 512t) | 64/64 | 88458.5 / 121608.9 | 9.8 / 16.7 | 137135.4 / 173341.0 | 104.9 | 26.85 | — | done |
| chat__in-large__out-medium__c64 | 64 | in=large out=medium (16384t / 512t) | 128/128 | 211704.5 / 476685.1 | 9.5 / 14.1 | 264786.4 / 532893.8 | 102.1 | 51.40 | — | done |
| chat__in-large__out-medium__c128 | 128 | in=large out=medium (16384t / 512t) | 206/256 | 222995.8 / 915236.8 | 9.5 / 12.9 | 275825.7 / 969153.1 | 95.7 | 108.26 | timeout:50 | done |
| chat__in-large__out-medium__c256 | 256 | in=large out=medium (16384t / 512t) | 309/512 | 223762.7 / 926692.5 | 9.4 / 12.8 | 276980.3 / 961446.9 | 89.4 | 180.13 | timeout:203 | done |
| chat__in-large__out-medium__c512 | 512 | in=large out=medium (16384t / 512t) | 157/1024 | 227195.2 / 913092.3 | 9.6 / 12.4 | 281711.5 / 950534.9 | 43.3 | 412.17 | timeout:859 network:8 | degraded (867/1024 failed) |
| chat__in-large__out-long__c1 | 1 | in=large out=long (16384t / 2048t) | 32/32 | 2763.3 / 3112.5 | 44.9 / 56.5 | 43416.4 / 48660.4 | 43.4 | 1.00 | — | done |
| chat__in-large__out-long__c4 | 4 | in=large out=long (16384t / 2048t) | 32/32 | 2852.5 / 6223.7 | 27.7 / 32.7 | 67890.6 / 81571.5 | 102.9 | 3.86 | — | done |
| chat__in-large__out-long__c8 | 8 | in=large out=long (16384t / 2048t) | 32/32 | 3339.5 / 15519.0 | 18.4 / 23.7 | 101118.1 / 123981.8 | 138.6 | 7.58 | — | done |
| chat__in-large__out-long__c32 | 32 | in=large out=long (16384t / 2048t) | 64/64 | 157659.8 / 246156.3 | 14.6 / 22.5 | 267288.8 / 300310.8 | 171.3 | 26.70 | — | done |
| chat__in-large__out-long__c64 | 64 | in=large out=long (16384t / 2048t) | 122/128 | 225721.7 / 937812.7 | 16.3 / 21.9 | 300149.1 / 1059675.6 | 178.9 | 52.16 | http_5xx:6 | done |
| chat__in-large__out-long__c128 | 128 | in=large out=long (16384t / 2048t) | 256/256 | 252407.2 / 730359.9 | 15.4 / 22.6 | 665751.4 / 993645.6 | 182.0 | 95.58 | — | done |
| chat__in-large__out-long__c256 | 256 | in=large out=long (16384t / 2048t) | 442/512 | 251094.6 / 823859.4 | 14.9 / 21.2 | 251240.0 / 1020025.7 | 173.8 | 202.05 | http_5xx:49 timeout:21 | done |
| chat__in-large__out-long__c512 | 512 | in=large out=long (16384t / 2048t) | 444/1024 | 712675.0 / 1652118.4 | 18.3 / 25.0 | 1260466.8 / 1739865.6 | 131.8 | 433.96 | network:3 timeout:455 http_5xx:122 | degraded (580/1024 failed) |
| chat__in-huge__out-short__c1 | 1 | in=huge out=short (65536t / 64t) | 32/32 | 11126.8 / 11566.0 | 30.3 / 41.6 | 11974.8 / 12447.1 | 2.1 | 1.00 | — | done |
| chat__in-huge__out-short__c4 | 4 | in=huge out=short (65536t / 64t) | 32/32 | 35088.5 / 38506.0 | 4.4 / 6.5 | 40643.4 / 44902.4 | 2.4 | 3.86 | — | done |
| chat__in-huge__out-short__c8 | 8 | in=huge out=short (65536t / 64t) | 32/32 | 76433.4 / 79410.0 | 4.3 / 5.6 | 82110.9 / 85872.5 | 2.4 | 7.24 | — | done |
| chat__in-huge__out-short__c32 | 32 | in=huge out=short (65536t / 64t) | 64/64 | 240137.5 / 644979.4 | 4.5 / 6.3 | 244369.0 / 652934.1 | 2.4 | 24.59 | — | done |
| chat__in-huge__out-short__c64 | 64 | in=huge out=short (65536t / 64t) | 128/128 | 249694.0 / 463501.2 | 4.4 / 6.1 | 256145.4 / 506309.8 | 2.2 | 44.79 | — | done |
| chat__in-huge__out-short__c128 | 128 | in=huge out=short (65536t / 64t) | 256/256 | 252747.2 / 438184.5 | 4.5 / 5.7 | 341170.0 / 539990.1 | 2.4 | 95.33 | — | done |
| chat__in-huge__out-short__c256 | 256 | in=huge out=short (65536t / 64t) | 511/512 | 252727.6 / 499952.5 | 4.4 / 5.8 | 539898.8 / 823853.5 | 2.3 | 204.01 | http_5xx:1 | done |
| chat__in-huge__out-short__c512 | 512 | in=huge out=short (65536t / 64t) | 857/1024 | 533126.6 / 1005706.7 | 4.4 / 5.5 | 539986.0 / 1859665.3 | 1.8 | 395.37 | timeout:89 http_5xx:73 network:5 | done |
| chat__in-huge__out-medium__c1 | 1 | in=huge out=medium (65536t / 512t) | 32/32 | 10809.0 / 11021.4 | 31.3 / 39.9 | 26247.1 / 28189.1 | 18.4 | 1.00 | — | done |
| chat__in-huge__out-medium__c4 | 4 | in=huge out=medium (65536t / 512t) | 32/32 | 12942.1 / 29977.3 | 9.6 / 14.3 | 64358.7 / 78694.5 | 28.3 | 3.91 | — | done |
| chat__in-huge__out-medium__c8 | 8 | in=huge out=medium (65536t / 512t) | 32/32 | 62037.3 / 93821.1 | 7.5 / 12.1 | 122716.6 / 158766.9 | 29.1 | 7.65 | — | done |
| chat__in-huge__out-medium__c32 | 32 | in=huge out=medium (65536t / 512t) | 64/64 | 221294.8 / 258805.7 | 7.6 / 11.1 | 284740.8 / 758849.6 | 29.8 | 28.17 | — | done |
| chat__in-huge__out-medium__c64 | 64 | in=huge out=medium (65536t / 512t) | 128/128 | 252733.4 / 476006.0 | 7.8 / 11.1 | 495884.9 / 545032.4 | 29.3 | 51.93 | — | done |
| chat__in-huge__out-medium__c128 | 128 | in=huge out=medium (65536t / 512t) | 256/256 | 252761.1 / 572821.6 | 7.4 / 10.3 | 504447.1 / 779586.9 | 28.9 | 97.02 | — | done |
| chat__in-huge__out-medium__c256 | 256 | in=huge out=medium (65536t / 512t) | 500/512 | 252713.6 / 635334.1 | 7.8 / 11.0 | 540337.8 / 839487.2 | 27.7 | 203.57 | http_5xx:6 timeout:6 | done |
| chat__in-huge__out-medium__c512 | 512 | in=huge out=medium (65536t / 512t) | 881/1024 | 508528.0 / 1115876.8 | 7.4 / 11.5 | 539998.8 / 1859260.8 | 24.5 | 389.84 | timeout:97 http_5xx:46 | done |
| chat__in-huge__out-long__c1 | 1 | in=huge out=long (65536t / 2048t) | 32/32 | 10648.9 / 10880.7 | 33.8 / 44.6 | 56073.3 / 70027.1 | 28.2 | 1.00 | — | done |
| chat__in-huge__out-long__c4 | 4 | in=huge out=long (65536t / 2048t) | 32/32 | 12777.6 / 27462.8 | 15.8 / 21.7 | 115865.0 / 164802.7 | 55.8 | 3.96 | — | done |
| chat__in-huge__out-long__c8 | 8 | in=huge out=long (65536t / 2048t) | 32/32 | 101821.5 / 154858.1 | 12.9 / 17.9 | 218838.2 / 293889.4 | 58.2 | 7.55 | — | done |
| chat__in-huge__out-long__c32 | 32 | in=huge out=long (65536t / 2048t) | 61/64 | 249505.6 / 751520.6 | 13.5 / 21.7 | 378170.6 / 1016389.7 | 59.4 | 25.42 | http_5xx:3 | done |
| chat__in-huge__out-long__c64 | 64 | in=huge out=long (65536t / 2048t) | 128/128 | 252686.4 / 452942.6 | 14.9 / 19.7 | 495287.4 / 583281.0 | 60.1 | 55.62 | — | done |
| chat__in-huge__out-long__c128 | 128 | in=huge out=long (65536t / 2048t) | 256/256 | 252729.0 / 338547.0 | 14.4 / 18.9 | 493328.0 / 779723.4 | 58.4 | 103.02 | — | done |
| chat__in-huge__out-long__c256 | 256 | in=huge out=long (65536t / 2048t) | 463/512 | 252685.0 / 623375.8 | 13.1 / 25.3 | 772629.1 / 1079737.2 | 52.9 | 188.03 | http_5xx:13 timeout:36 | done |
| chat__in-huge__out-long__c512 | 512 | in=huge out=long (65536t / 2048t) | 870/1024 | 504909.2 / 758092.5 | 14.3 / 22.6 | 541915.4 / 1859892.3 | 56.5 | 391.17 | http_5xx:74 timeout:80 | done |

## Concurrency Curves

### concurrency vs agg out tps

| params | c=1 | c=4 | c=8 | c=32 | c=64 | c=128 | c=256 | c=512 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| in=tiny out=short (256t / 64t) | 23.4 | 46.1 | 90.0 | 152.6 | 160.3 | 155.3 | 158.9 | 158.3 |
| in=tiny out=medium (256t / 512t) | 44.5 | 119.3 | 184.1 | 315.2 | 318.3 | 75.5 | 46.5 | 73.1 |
| in=tiny out=long (256t / 2048t) | 50.0 | 136.1 | 200.9 | 318.9 | 340.2 | 342.6 | 327.1 | 156.2 |
| in=small out=short (1024t / 64t) | 17.3 | 50.8 | 70.5 | 102.3 | 102.5 | 106.6 | 107.8 | 107.0 |
| in=small out=medium (1024t / 512t) | 43.7 | 120.5 | 180.8 | 272.4 | 279.4 | 70.4 | 44.9 | 66.3 |
| in=small out=long (1024t / 2048t) | 50.6 | 133.0 | 198.2 | 291.4 | 352.1 | 339.5 | 297.7 | 142.9 |
| in=medium out=short (4096t / 64t) | 14.5 | 28.9 | 36.0 | 40.4 | 39.9 | 39.6 | 24.9 | 14.3 |
| in=medium out=medium (4096t / 512t) | 41.0 | 108.7 | 154.8 | 199.7 | 198.0 | 30.5 | 30.0 | 45.2 |
| in=medium out=long (4096t / 2048t) | 48.8 | 129.9 | 183.6 | 238.7 | 268.2 | 262.0 | 236.9 | 116.3 |
| in=large out=short (16384t / 64t) | 6.7 | 9.9 | 10.3 | 10.8 | 11.0 | 9.4 | 7.4 | 3.8 |
| in=large out=medium (16384t / 512t) | 32.7 | 73.8 | 95.5 | 104.9 | 102.1 | 95.7 | 89.4 | 43.3 |
| in=large out=long (16384t / 2048t) | 43.4 | 102.9 | 138.6 | 171.3 | 178.9 | 182.0 | 173.8 | 131.8 |
| in=huge out=short (65536t / 64t) | 2.1 | 2.4 | 2.4 | 2.4 | 2.2 | 2.4 | 2.3 | 1.8 |
| in=huge out=medium (65536t / 512t) | 18.4 | 28.3 | 29.1 | 29.8 | 29.3 | 28.9 | 27.7 | 24.5 |
| in=huge out=long (65536t / 2048t) | 28.2 | 55.8 | 58.2 | 59.4 | 60.1 | 58.4 | 52.9 | 56.5 |


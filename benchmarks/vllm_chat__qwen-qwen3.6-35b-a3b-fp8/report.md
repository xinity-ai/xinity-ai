# Benchmark Report — chat

- **run_id**: `2026-05-10T20-04-57Z__chat__qwen-qwen3.6-35b-a3b-fp8`
- **model**: `Qwen/Qwen3.6-35B-A3B-FP8`
- **base_url host**: `localhost:11435`
- **started**: 2026-05-10T20:04:57.927Z  →  2026-05-11T15:08:41.586Z
- **bun**: 1.3.1, **platform**: linux, **cpus**: 12, **mem**: 57MB
- **git**: `c84e7ff15e5867372ccf05d40fe3d678a2c0181d`

## Preflight
- reachable: true, smoke: true
- context probe: ≥ 262144 ok, < 524288 fails (tried 8192, 32768, 131072, 262144, 524288)
- cache probe: first 353.8ms, second 235.9ms (ratio 0.67)

## Rollup
- scenarios: 89 done, 0 skipped, 31 degraded, 0 aborted (total 120)
- requests: 16239 ok / 31200 (14961 failed)

## Scenarios

| scenario | conc | params | n / ok | ttft p50/p95 (ms) | tps p50/p95 | wall p50/p95 (ms) | agg out tps | eff conc | err | status |
| --- | ---: | --- | ---: | --- | --- | --- | ---: | ---: | --- | --- |
| chat__in-tiny__out-short__c1 | 1 | in=tiny out=short (256t / 64t) | 32/32 | 265.0 / 269.4 | 39.2 / 54.5 | 939.2 / 1139.5 | 27.9 | 1.00 | — | done |
| chat__in-tiny__out-short__c4 | 4 | in=tiny out=short (256t / 64t) | 32/32 | 409.3 / 568.2 | 23.2 / 34.4 | 1537.0 / 2007.0 | 64.4 | 3.92 | — | done |
| chat__in-tiny__out-short__c8 | 8 | in=tiny out=short (256t / 64t) | 32/32 | 489.6 / 822.5 | 16.8 / 23.9 | 2051.5 / 2760.9 | 91.1 | 7.50 | — | done |
| chat__in-tiny__out-short__c32 | 32 | in=tiny out=short (256t / 64t) | 64/64 | 1646.3 / 3895.6 | 10.1 / 17.2 | 3946.1 / 7088.0 | 157.1 | 28.38 | — | done |
| chat__in-tiny__out-short__c64 | 64 | in=tiny out=short (256t / 64t) | 128/128 | 6854.1 / 8211.7 | 9.1 / 15.7 | 9095.7 / 11226.1 | 154.5 | 52.93 | — | done |
| chat__in-tiny__out-short__c128 | 128 | in=tiny out=short (256t / 64t) | 256/256 | 16150.9 / 17365.2 | 8.9 / 13.0 | 18612.7 / 20594.4 | 158.4 | 100.51 | — | done |
| chat__in-tiny__out-short__c256 | 256 | in=tiny out=short (256t / 64t) | 512/512 | 36537.2 / 37603.4 | 8.7 / 11.8 | 38850.1 / 41071.9 | 159.9 | 198.05 | — | done |
| chat__in-tiny__out-short__c512 | 512 | in=tiny out=short (256t / 64t) | 1024/1024 | 75065.2 / 78172.5 | 8.6 / 11.5 | 77698.2 / 81355.4 | 158.9 | 387.73 | — | done |
| chat__in-tiny__out-medium__c1 | 1 | in=tiny out=medium (256t / 512t) | 32/32 | 268.7 / 274.5 | 46.7 / 51.7 | 11095.5 / 12131.6 | 45.9 | 1.00 | — | done |
| chat__in-tiny__out-medium__c4 | 4 | in=tiny out=medium (256t / 512t) | 32/32 | 386.2 / 569.1 | 32.1 / 36.2 | 16396.6 / 17899.3 | 125.5 | 3.99 | — | done |
| chat__in-tiny__out-medium__c8 | 8 | in=tiny out=medium (256t / 512t) | 32/32 | 481.5 / 747.9 | 24.5 / 26.7 | 21378.4 / 23189.3 | 185.9 | 7.83 | — | done |
| chat__in-tiny__out-medium__c32 | 32 | in=tiny out=medium (256t / 512t) | 64/64 | 3184.2 / 33463.9 | 15.7 / 17.4 | 36272.0 / 67521.9 | 319.1 | 27.78 | — | done |
| chat__in-tiny__out-medium__c64 | 64 | in=tiny out=medium (256t / 512t) | 128/128 | 65931.5 / 69784.7 | 15.2 / 17.7 | 97327.8 / 104937.3 | 317.8 | 51.65 | — | done |
| chat__in-tiny__out-medium__c128 | 128 | in=tiny out=medium (256t / 512t) | 256/256 | 154768.1 / 172436.7 | 15.0 / 17.2 | 189050.8 / 207738.9 | 319.8 | 99.53 | — | done |
| chat__in-tiny__out-medium__c256 | 256 | in=tiny out=medium (256t / 512t) | 370/512 | 234082.0 / 270902.8 | 15.0 / 16.7 | 268305.1 / 304563.1 | 320.2 | 204.68 | stream_parse:142 | done |
| chat__in-tiny__out-medium__c512 | 512 | in=tiny out=medium (256t / 512t) | 691/1024 | 348660.7 / 586835.4 | 14.9 / 16.7 | 382318.8 / 618864.3 | 322.8 | 368.82 | stream_parse:258 timeout:75 | done |
| chat__in-tiny__out-long__c1 | 1 | in=tiny out=long (256t / 2048t) | 32/32 | 268.9 / 279.4 | 50.0 / 55.0 | 38322.5 / 43029.4 | 50.2 | 1.00 | — | done |
| chat__in-tiny__out-long__c4 | 4 | in=tiny out=long (256t / 2048t) | 32/32 | 395.7 / 575.4 | 35.0 / 38.8 | 54336.2 / 60297.6 | 136.1 | 3.88 | — | done |
| chat__in-tiny__out-long__c8 | 8 | in=tiny out=long (256t / 2048t) | 32/32 | 498.1 / 734.6 | 26.7 / 28.4 | 73214.6 / 81209.4 | 202.4 | 7.64 | — | done |
| chat__in-tiny__out-long__c32 | 32 | in=tiny out=long (256t / 2048t) | 64/64 | 22846.9 / 115982.4 | 16.4 / 17.9 | 138378.1 / 238308.4 | 316.4 | 26.77 | — | done |
| chat__in-tiny__out-long__c64 | 64 | in=tiny out=long (256t / 2048t) | 123/128 | 231893.4 / 251982.0 | 16.1 / 18.1 | 346714.1 / 377114.4 | 324.8 | 52.06 | stream_parse:5 | done |
| chat__in-tiny__out-long__c128 | 128 | in=tiny out=long (256t / 2048t) | 125/256 | 235915.2 / 251499.8 | 16.2 / 17.8 | 346443.6 / 381622.7 | 323.8 | 101.56 | stream_parse:131 | degraded (131/256 failed) |
| chat__in-tiny__out-long__c256 | 256 | in=tiny out=long (256t / 2048t) | 122/512 | 236862.8 / 258191.1 | 16.1 / 18.8 | 346030.4 / 382353.4 | 320.6 | 201.62 | stream_parse:390 | degraded (390/512 failed) |
| chat__in-tiny__out-long__c512 | 512 | in=tiny out=long (256t / 2048t) | 242/1024 | 484282.4 / 722993.1 | 15.9 / 17.8 | 607353.9 / 844395.3 | 320.8 | 367.68 | stream_parse:782 | degraded (782/1024 failed) |
| chat__in-small__out-short__c1 | 1 | in=small out=short (1024t / 64t) | 32/32 | 334.9 / 382.2 | 40.5 / 54.4 | 981.4 / 1224.2 | 26.2 | 1.00 | — | done |
| chat__in-small__out-short__c4 | 4 | in=small out=short (1024t / 64t) | 32/32 | 544.0 / 770.3 | 19.6 / 28.0 | 1783.9 / 2280.6 | 54.5 | 3.95 | — | done |
| chat__in-small__out-short__c8 | 8 | in=small out=short (1024t / 64t) | 32/32 | 665.5 / 1375.3 | 13.5 / 24.0 | 2545.9 / 3586.5 | 73.2 | 7.77 | — | done |
| chat__in-small__out-short__c32 | 32 | in=small out=short (1024t / 64t) | 64/64 | 3030.9 / 6058.7 | 6.6 / 17.1 | 6497.7 / 10269.7 | 102.9 | 28.84 | — | done |
| chat__in-small__out-short__c64 | 64 | in=small out=short (1024t / 64t) | 128/128 | 10197.2 / 12039.4 | 6.1 / 12.3 | 13549.5 / 16813.0 | 105.8 | 54.06 | — | done |
| chat__in-small__out-short__c128 | 128 | in=small out=short (1024t / 64t) | 256/256 | 24516.1 / 25786.7 | 6.0 / 8.7 | 27716.9 / 31083.5 | 105.8 | 102.06 | — | done |
| chat__in-small__out-short__c256 | 256 | in=small out=short (1024t / 64t) | 512/512 | 53318.3 / 54486.9 | 6.0 / 8.1 | 56484.2 / 59547.0 | 108.0 | 198.59 | — | done |
| chat__in-small__out-short__c512 | 512 | in=small out=short (1024t / 64t) | 1024/1024 | 111438.0 / 112785.9 | 6.0 / 8.0 | 114535.8 / 117934.8 | 108.0 | 390.89 | — | done |
| chat__in-small__out-medium__c1 | 1 | in=small out=medium (1024t / 512t) | 32/32 | 335.8 / 397.4 | 45.3 / 51.7 | 11540.1 / 12618.0 | 44.2 | 1.00 | — | done |
| chat__in-small__out-medium__c4 | 4 | in=small out=medium (1024t / 512t) | 32/32 | 457.7 / 786.3 | 32.2 / 35.5 | 16278.3 / 18170.3 | 123.0 | 3.95 | — | done |
| chat__in-small__out-medium__c8 | 8 | in=small out=medium (1024t / 512t) | 32/32 | 670.5 / 1821.3 | 23.9 / 26.9 | 21944.6 / 24251.7 | 180.6 | 7.86 | — | done |
| chat__in-small__out-medium__c32 | 32 | in=small out=medium (1024t / 512t) | 64/64 | 5571.4 / 36929.6 | 14.4 / 16.5 | 41766.5 / 73723.0 | 274.6 | 26.89 | — | done |
| chat__in-small__out-medium__c64 | 64 | in=small out=medium (1024t / 512t) | 128/128 | 73421.2 / 79077.8 | 14.1 / 16.4 | 108578.3 / 117578.2 | 278.0 | 50.91 | — | done |
| chat__in-small__out-medium__c128 | 128 | in=small out=medium (1024t / 512t) | 256/256 | 184203.8 / 191564.1 | 14.0 / 16.3 | 218453.4 / 231128.9 | 284.4 | 98.76 | — | done |
| chat__in-small__out-medium__c256 | 256 | in=small out=medium (1024t / 512t) | 321/512 | 220209.9 / 266716.6 | 14.0 / 16.0 | 255870.9 / 303318.8 | 284.4 | 209.17 | stream_parse:191 | done |
| chat__in-small__out-medium__c512 | 512 | in=small out=medium (1024t / 512t) | 622/1024 | 342644.4 / 577004.0 | 13.7 / 15.9 | 379557.9 / 614404.6 | 283.5 | 365.46 | stream_parse:323 timeout:79 | done |
| chat__in-small__out-long__c1 | 1 | in=small out=long (1024t / 2048t) | 32/32 | 336.5 / 353.5 | 51.7 / 54.8 | 38117.7 / 42761.4 | 51.0 | 1.00 | — | done |
| chat__in-small__out-long__c4 | 4 | in=small out=long (1024t / 2048t) | 32/32 | 461.4 / 776.5 | 35.5 / 38.3 | 54562.3 / 62496.0 | 136.0 | 3.88 | — | done |
| chat__in-small__out-long__c8 | 8 | in=small out=long (1024t / 2048t) | 32/32 | 567.0 / 1450.7 | 26.4 / 29.1 | 69165.2 / 78320.6 | 202.5 | 7.73 | — | done |
| chat__in-small__out-long__c32 | 32 | in=small out=long (1024t / 2048t) | 64/64 | 27200.5 / 123233.0 | 16.1 / 19.2 | 145936.1 / 248108.7 | 295.5 | 26.42 | — | done |
| chat__in-small__out-long__c64 | 64 | in=small out=long (1024t / 2048t) | 118/128 | 239026.4 / 258853.1 | 15.7 / 18.3 | 355124.2 / 395087.8 | 304.6 | 51.74 | stream_parse:10 | done |
| chat__in-small__out-long__c128 | 128 | in=small out=long (1024t / 2048t) | 119/256 | 239337.3 / 252412.9 | 15.7 / 18.2 | 353798.3 / 379116.0 | 305.7 | 102.07 | stream_parse:137 | degraded (137/256 failed) |
| chat__in-small__out-long__c256 | 256 | in=small out=long (1024t / 2048t) | 118/512 | 237168.2 / 261387.0 | 15.7 / 18.4 | 348194.9 / 383247.6 | 304.7 | 202.63 | stream_parse:394 | degraded (394/512 failed) |
| chat__in-small__out-long__c512 | 512 | in=small out=long (1024t / 2048t) | 229/1024 | 478834.8 / 719289.4 | 15.4 / 18.2 | 605524.1 / 835457.7 | 304.1 | 372.69 | stream_parse:795 | degraded (795/1024 failed) |
| chat__in-medium__out-short__c1 | 1 | in=medium out=short (4096t / 64t) | 32/32 | 1123.8 / 1341.9 | 39.1 / 63.1 | 1729.7 / 1945.6 | 14.5 | 1.00 | — | done |
| chat__in-medium__out-short__c4 | 4 | in=medium out=short (4096t / 64t) | 32/32 | 1537.7 / 2299.0 | 14.9 / 27.0 | 3224.7 / 4224.0 | 30.2 | 3.97 | — | done |
| chat__in-medium__out-short__c8 | 8 | in=medium out=short (4096t / 64t) | 32/32 | 2188.2 / 4575.5 | 8.1 / 15.2 | 5328.2 / 7596.9 | 35.0 | 7.65 | — | done |
| chat__in-medium__out-short__c32 | 32 | in=medium out=short (4096t / 64t) | 64/64 | 14181.2 / 18055.6 | 5.1 / 9.6 | 18411.9 / 22934.3 | 37.6 | 27.60 | — | done |
| chat__in-medium__out-short__c64 | 64 | in=medium out=short (4096t / 64t) | 128/128 | 32234.9 / 34953.9 | 4.7 / 7.1 | 36669.1 / 41088.1 | 40.4 | 52.08 | — | done |
| chat__in-medium__out-short__c128 | 128 | in=medium out=short (4096t / 64t) | 256/256 | 70343.8 / 72565.3 | 4.7 / 6.6 | 74395.6 / 78677.3 | 39.8 | 100.07 | — | done |
| chat__in-medium__out-short__c256 | 256 | in=medium out=short (4096t / 64t) | 512/512 | 147046.7 / 149046.1 | 4.7 / 6.1 | 151093.1 / 155225.1 | 40.6 | 196.26 | — | done |
| chat__in-medium__out-short__c512 | 512 | in=medium out=short (4096t / 64t) | 1024/1024 | 260816.9 / 576488.5 | 4.7 / 6.2 | 265580.3 / 581639.7 | 40.5 | 388.16 | — | done |
| chat__in-medium__out-medium__c1 | 1 | in=medium out=medium (4096t / 512t) | 32/32 | 1022.9 / 1274.3 | 45.0 / 50.7 | 12300.4 / 13856.1 | 41.0 | 1.00 | — | done |
| chat__in-medium__out-medium__c4 | 4 | in=medium out=medium (4096t / 512t) | 32/32 | 1378.3 / 2241.3 | 29.3 / 33.9 | 18922.2 / 20933.2 | 106.8 | 3.95 | — | done |
| chat__in-medium__out-medium__c8 | 8 | in=medium out=medium (4096t / 512t) | 32/32 | 1509.4 / 4503.5 | 21.1 / 24.3 | 25609.1 / 28647.8 | 153.7 | 7.81 | — | done |
| chat__in-medium__out-medium__c32 | 32 | in=medium out=medium (4096t / 512t) | 64/64 | 39968.2 / 50808.9 | 12.1 / 21.1 | 64004.9 / 94790.2 | 200.0 | 26.86 | — | done |
| chat__in-medium__out-medium__c64 | 64 | in=medium out=medium (4096t / 512t) | 128/128 | 101119.3 / 131843.4 | 11.6 / 16.7 | 143616.4 / 175157.1 | 206.1 | 52.18 | — | done |
| chat__in-medium__out-medium__c128 | 128 | in=medium out=medium (4096t / 512t) | 241/256 | 224754.5 / 269190.9 | 11.7 / 15.4 | 265249.1 / 309966.2 | 209.8 | 99.61 | stream_parse:15 | done |
| chat__in-medium__out-medium__c256 | 256 | in=medium out=medium (4096t / 512t) | 245/512 | 227944.3 / 273436.9 | 11.5 / 14.4 | 270246.8 / 313793.7 | 208.6 | 221.78 | stream_parse:267 | degraded (267/512 failed) |
| chat__in-medium__out-medium__c512 | 512 | in=medium out=medium (4096t / 512t) | 482/1024 | 351272.3 / 593434.2 | 11.6 / 14.4 | 395200.5 / 629377.2 | 209.0 | 380.58 | stream_parse:489 timeout:53 | degraded (542/1024 failed) |
| chat__in-medium__out-long__c1 | 1 | in=medium out=long (4096t / 2048t) | 32/32 | 1030.2 / 1336.9 | 50.0 / 59.9 | 38996.9 / 44423.3 | 49.3 | 1.00 | — | done |
| chat__in-medium__out-long__c4 | 4 | in=medium out=long (4096t / 2048t) | 32/32 | 1227.5 / 2549.8 | 33.3 / 39.0 | 56936.9 / 64543.9 | 129.9 | 3.90 | — | done |
| chat__in-medium__out-long__c8 | 8 | in=medium out=long (4096t / 2048t) | 32/32 | 1329.2 / 4561.6 | 24.2 / 27.7 | 78078.2 / 91522.7 | 183.1 | 7.65 | — | done |
| chat__in-medium__out-long__c32 | 32 | in=medium out=long (4096t / 2048t) | 64/64 | 109362.8 / 143514.0 | 14.4 / 18.6 | 223124.8 / 270883.0 | 240.0 | 26.84 | — | done |
| chat__in-medium__out-long__c64 | 64 | in=medium out=long (4096t / 2048t) | 87/128 | 150950.6 / 265910.6 | 13.9 / 18.2 | 289810.8 / 377491.9 | 235.8 | 50.91 | stream_parse:41 | done |
| chat__in-medium__out-long__c128 | 128 | in=medium out=long (4096t / 2048t) | 91/256 | 149604.8 / 277485.6 | 14.1 / 18.2 | 284292.8 / 405081.3 | 241.5 | 101.76 | stream_parse:165 | degraded (165/256 failed) |
| chat__in-medium__out-long__c256 | 256 | in=medium out=long (4096t / 2048t) | 95/512 | 173993.0 / 271285.0 | 14.0 / 19.6 | 314841.5 / 412004.8 | 242.2 | 199.48 | stream_parse:417 | degraded (417/512 failed) |
| chat__in-medium__out-long__c512 | 512 | in=medium out=long (4096t / 2048t) | 178/1024 | 454127.2 / 700416.4 | 13.8 / 17.2 | 598818.8 / 832424.5 | 242.0 | 382.85 | stream_parse:846 | degraded (846/1024 failed) |
| chat__in-large__out-short__c1 | 1 | in=large out=short (16384t / 64t) | 32/32 | 2837.2 / 2966.3 | 38.0 / 60.1 | 3426.8 / 3888.2 | 7.0 | 1.00 | — | done |
| chat__in-large__out-short__c4 | 4 | in=large out=short (16384t / 64t) | 32/32 | 4741.1 / 8554.5 | 5.7 / 20.7 | 8956.0 / 12630.8 | 10.8 | 3.95 | — | done |
| chat__in-large__out-short__c8 | 8 | in=large out=short (16384t / 64t) | 32/32 | 13317.6 / 15477.3 | 5.0 / 8.5 | 17738.5 / 20767.4 | 10.1 | 7.59 | — | done |
| chat__in-large__out-short__c32 | 32 | in=large out=short (16384t / 64t) | 64/64 | 64766.5 / 68715.7 | 4.8 / 7.0 | 68739.1 / 75017.9 | 10.3 | 25.30 | — | done |
| chat__in-large__out-short__c64 | 64 | in=large out=short (16384t / 64t) | 128/128 | 136036.2 / 138931.0 | 4.9 / 6.2 | 140235.2 / 144759.3 | 10.9 | 49.43 | — | done |
| chat__in-large__out-short__c128 | 128 | in=large out=short (16384t / 64t) | 235/256 | 239137.4 / 270566.0 | 4.9 / 6.3 | 243570.1 / 276033.7 | 10.6 | 96.09 | stream_parse:21 | done |
| chat__in-large__out-short__c256 | 256 | in=large out=short (16384t / 64t) | 263/512 | 240313.3 / 283286.5 | 4.9 / 6.4 | 244532.0 / 287411.7 | 10.5 | 213.40 | stream_parse:249 | done |
| chat__in-large__out-short__c512 | 512 | in=large out=short (16384t / 64t) | 524/1024 | 474722.8 / 695322.1 | 4.8 / 6.2 | 479744.1 / 700530.1 | 10.6 | 387.87 | stream_parse:500 | done |
| chat__in-large__out-medium__c1 | 1 | in=large out=medium (16384t / 512t) | 32/32 | 2803.2 / 3068.3 | 40.3 / 42.8 | 15356.7 / 16820.3 | 32.5 | 1.00 | — | done |
| chat__in-large__out-medium__c4 | 4 | in=large out=medium (16384t / 512t) | 32/32 | 3582.6 / 7618.3 | 21.9 / 28.3 | 27002.6 / 30418.3 | 74.2 | 3.97 | — | done |
| chat__in-large__out-medium__c8 | 8 | in=large out=medium (16384t / 512t) | 32/32 | 4953.8 / 15408.9 | 13.5 / 19.6 | 40675.6 / 54326.4 | 93.9 | 7.85 | — | done |
| chat__in-large__out-medium__c32 | 32 | in=large out=medium (16384t / 512t) | 64/64 | 87473.1 / 122156.9 | 9.7 / 15.6 | 139217.4 / 175396.5 | 102.8 | 26.79 | — | done |
| chat__in-large__out-medium__c64 | 64 | in=large out=medium (16384t / 512t) | 123/128 | 224881.4 / 249153.8 | 9.5 / 14.1 | 276615.3 / 297932.8 | 106.7 | 51.17 | stream_parse:5 | done |
| chat__in-large__out-medium__c128 | 128 | in=large out=medium (16384t / 512t) | 127/256 | 239001.2 / 280908.9 | 9.5 / 14.0 | 290938.9 / 319310.2 | 103.6 | 112.55 | stream_parse:129 | degraded (129/256 failed) |
| chat__in-large__out-medium__c256 | 256 | in=large out=medium (16384t / 512t) | 124/512 | 237172.9 / 280646.7 | 9.4 / 11.6 | 289081.8 / 320134.4 | 100.7 | 236.31 | stream_parse:388 | degraded (388/512 failed) |
| chat__in-large__out-medium__c512 | 512 | in=large out=medium (16384t / 512t) | 255/1024 | 469119.3 / 699877.3 | 9.4 / 12.1 | 522245.8 / 755238.4 | 104.7 | 426.89 | stream_parse:769 | degraded (769/1024 failed) |
| chat__in-large__out-long__c1 | 1 | in=large out=long (16384t / 2048t) | 32/32 | 2550.9 / 2785.5 | 45.1 / 56.0 | 42109.8 / 47400.1 | 43.7 | 1.00 | — | done |
| chat__in-large__out-long__c4 | 4 | in=large out=long (16384t / 2048t) | 32/32 | 2873.3 / 6252.5 | 27.8 / 35.7 | 66233.1 / 79188.6 | 105.2 | 3.85 | — | done |
| chat__in-large__out-long__c8 | 8 | in=large out=long (16384t / 2048t) | 32/32 | 3470.7 / 15129.7 | 18.7 / 23.9 | 98683.0 / 122078.4 | 139.7 | 7.73 | — | done |
| chat__in-large__out-long__c32 | 32 | in=large out=long (16384t / 2048t) | 60/64 | 167639.4 / 258232.8 | 14.1 / 18.3 | 286092.8 / 395317.3 | 158.5 | 26.20 | stream_parse:4 | done |
| chat__in-large__out-long__c64 | 64 | in=large out=long (16384t / 2048t) | 64/128 | 232895.5 / 284207.1 | 13.9 / 20.1 | 344778.9 / 412791.7 | 157.0 | 51.99 | stream_parse:64 | degraded (64/128 failed) |
| chat__in-large__out-long__c128 | 128 | in=large out=long (16384t / 2048t) | 62/256 | 187052.0 / 261542.2 | 13.7 / 20.7 | 311738.4 / 382324.0 | 156.8 | 103.82 | stream_parse:194 | degraded (194/256 failed) |
| chat__in-large__out-long__c256 | 256 | in=large out=long (16384t / 2048t) | 65/512 | 191262.6 / 272400.5 | 13.8 / 18.3 | 321846.6 / 413346.5 | 156.7 | 200.64 | stream_parse:447 | degraded (447/512 failed) |
| chat__in-large__out-long__c512 | 512 | in=large out=long (16384t / 2048t) | 123/1024 | 527972.4 / 634984.2 | 13.4 / 17.8 | 662142.7 / 777197.8 | 156.4 | 369.11 | stream_parse:901 | degraded (901/1024 failed) |
| chat__in-huge__out-short__c1 | 1 | in=huge out=short (65536t / 64t) | 32/32 | 11011.7 / 11438.0 | 30.9 / 48.3 | 11925.6 / 12332.7 | 2.1 | 1.00 | — | done |
| chat__in-huge__out-short__c4 | 4 | in=huge out=short (65536t / 64t) | 32/32 | 35664.8 / 38230.2 | 4.4 / 5.6 | 42027.6 / 45018.3 | 2.5 | 3.86 | — | done |
| chat__in-huge__out-short__c8 | 8 | in=huge out=short (65536t / 64t) | 32/32 | 76892.9 / 79227.6 | 4.5 / 5.4 | 82786.8 / 86144.5 | 2.5 | 7.25 | — | done |
| chat__in-huge__out-short__c32 | 32 | in=huge out=short (65536t / 64t) | 55/64 | 241354.9 / 274053.1 | 4.4 / 6.2 | 246885.8 / 278811.9 | 2.4 | 23.51 | stream_parse:9 | done |
| chat__in-huge__out-short__c64 | 64 | in=huge out=short (65536t / 64t) | 54/128 | 243148.7 / 272573.8 | 4.6 / 6.2 | 249234.0 / 276878.7 | 2.4 | 55.74 | stream_parse:74 | degraded (74/128 failed) |
| chat__in-huge__out-short__c128 | 128 | in=huge out=short (65536t / 64t) | 52/256 | 241720.8 / 268484.5 | 4.5 / 6.3 | 247191.9 / 275678.3 | 2.4 | 119.92 | stream_parse:204 | degraded (204/256 failed) |
| chat__in-huge__out-short__c256 | 256 | in=huge out=short (65536t / 64t) | 51/512 | 241759.3 / 266203.6 | 4.4 / 6.0 | 246985.1 / 271920.2 | 2.4 | 248.40 | stream_parse:461 | degraded (461/512 failed) |
| chat__in-huge__out-short__c512 | 512 | in=huge out=short (65536t / 64t) | 104/1024 | 493513.5 / 563627.6 | 4.3 / 5.8 | 499251.3 / 571247.1 | 2.2 | 434.08 | stream_parse:920 | degraded (920/1024 failed) |
| chat__in-huge__out-medium__c1 | 1 | in=huge out=medium (65536t / 512t) | 32/32 | 10986.4 / 11382.7 | 31.2 / 35.2 | 26632.5 / 28837.1 | 18.4 | 1.00 | — | done |
| chat__in-huge__out-medium__c4 | 4 | in=huge out=medium (65536t / 512t) | 32/32 | 21811.1 / 36515.7 | 10.5 / 16.3 | 64463.9 / 80867.9 | 28.4 | 3.96 | — | done |
| chat__in-huge__out-medium__c8 | 8 | in=huge out=medium (65536t / 512t) | 32/32 | 64767.8 / 90953.3 | 7.4 / 13.4 | 121090.8 / 157348.7 | 29.3 | 7.63 | — | done |
| chat__in-huge__out-medium__c32 | 32 | in=huge out=medium (65536t / 512t) | 36/64 | 196694.0 / 268587.7 | 7.4 / 11.3 | 261185.9 / 326662.2 | 29.4 | 27.41 | stream_parse:28 | done |
| chat__in-huge__out-medium__c64 | 64 | in=huge out=medium (65536t / 512t) | 34/128 | 184033.6 / 271316.1 | 7.3 / 11.5 | 248931.8 / 312546.7 | 28.5 | 59.15 | stream_parse:94 | degraded (94/128 failed) |
| chat__in-huge__out-medium__c128 | 128 | in=huge out=medium (65536t / 512t) | 36/256 | 201599.8 / 263459.2 | 7.4 / 11.7 | 264700.0 / 320201.4 | 29.2 | 118.36 | stream_parse:220 | degraded (220/256 failed) |
| chat__in-huge__out-medium__c256 | 256 | in=huge out=medium (65536t / 512t) | 34/512 | 190922.8 / 271038.2 | 7.6 / 12.7 | 258712.7 / 310872.8 | 29.0 | 245.47 | stream_parse:478 | degraded (478/512 failed) |
| chat__in-huge__out-medium__c512 | 512 | in=huge out=medium (65536t / 512t) | 72/1024 | 519448.2 / 572350.0 | 7.2 / 9.8 | 580529.5 / 644315.6 | 28.3 | 425.84 | stream_parse:952 | degraded (952/1024 failed) |
| chat__in-huge__out-long__c1 | 1 | in=huge out=long (65536t / 2048t) | 32/32 | 10949.5 / 11293.8 | 34.0 / 44.3 | 56975.6 / 66218.8 | 28.8 | 1.00 | — | done |
| chat__in-huge__out-long__c4 | 4 | in=huge out=long (65536t / 2048t) | 32/32 | 13041.8 / 28569.2 | 15.8 / 21.3 | 117545.1 / 141539.6 | 56.0 | 3.93 | — | done |
| chat__in-huge__out-long__c8 | 8 | in=huge out=long (65536t / 2048t) | 32/32 | 103833.7 / 164136.7 | 12.7 / 21.1 | 220470.5 / 307317.1 | 56.9 | 7.52 | — | done |
| chat__in-huge__out-long__c32 | 32 | in=huge out=long (65536t / 2048t) | 25/64 | 196860.1 / 258569.9 | 12.2 / 15.7 | 308228.6 / 391004.3 | 53.4 | 25.28 | stream_parse:39 | degraded (39/64 failed) |
| chat__in-huge__out-long__c64 | 64 | in=huge out=long (65536t / 2048t) | 24/128 | 176768.2 / 264190.2 | 12.2 / 19.2 | 296084.5 / 374424.6 | 51.8 | 54.44 | stream_parse:104 | degraded (104/128 failed) |
| chat__in-huge__out-long__c128 | 128 | in=huge out=long (65536t / 2048t) | 21/256 | 169557.7 / 248009.3 | 12.5 / 15.8 | 299967.0 / 374329.9 | 54.2 | 108.40 | stream_parse:235 | degraded (235/256 failed) |
| chat__in-huge__out-long__c256 | 256 | in=huge out=long (65536t / 2048t) | 22/512 | 163335.3 / 244801.7 | 12.2 / 19.3 | 289279.0 / 362688.6 | 52.6 | 218.87 | stream_parse:490 | degraded (490/512 failed) |
| chat__in-huge__out-long__c512 | 512 | in=huge out=long (65536t / 2048t) | 47/1024 | 518549.1 / 614921.0 | 12.3 / 16.6 | 641041.1 / 748345.1 | 55.3 | 375.57 | stream_parse:977 | degraded (977/1024 failed) |

## Concurrency Curves

### concurrency vs agg out tps

| params | c=1 | c=4 | c=8 | c=32 | c=64 | c=128 | c=256 | c=512 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| in=tiny out=short (256t / 64t) | 27.9 | 64.4 | 91.1 | 157.1 | 154.5 | 158.4 | 159.9 | 158.9 |
| in=tiny out=medium (256t / 512t) | 45.9 | 125.5 | 185.9 | 319.1 | 317.8 | 319.8 | 320.2 | 322.8 |
| in=tiny out=long (256t / 2048t) | 50.2 | 136.1 | 202.4 | 316.4 | 324.8 | 323.8 | 320.6 | 320.8 |
| in=small out=short (1024t / 64t) | 26.2 | 54.5 | 73.2 | 102.9 | 105.8 | 105.8 | 108.0 | 108.0 |
| in=small out=medium (1024t / 512t) | 44.2 | 123.0 | 180.6 | 274.6 | 278.0 | 284.4 | 284.4 | 283.5 |
| in=small out=long (1024t / 2048t) | 51.0 | 136.0 | 202.5 | 295.5 | 304.6 | 305.7 | 304.7 | 304.1 |
| in=medium out=short (4096t / 64t) | 14.5 | 30.2 | 35.0 | 37.6 | 40.4 | 39.8 | 40.6 | 40.5 |
| in=medium out=medium (4096t / 512t) | 41.0 | 106.8 | 153.7 | 200.0 | 206.1 | 209.8 | 208.6 | 209.0 |
| in=medium out=long (4096t / 2048t) | 49.3 | 129.9 | 183.1 | 240.0 | 235.8 | 241.5 | 242.2 | 242.0 |
| in=large out=short (16384t / 64t) | 7.0 | 10.8 | 10.1 | 10.3 | 10.9 | 10.6 | 10.5 | 10.6 |
| in=large out=medium (16384t / 512t) | 32.5 | 74.2 | 93.9 | 102.8 | 106.7 | 103.6 | 100.7 | 104.7 |
| in=large out=long (16384t / 2048t) | 43.7 | 105.2 | 139.7 | 158.5 | 157.0 | 156.8 | 156.7 | 156.4 |
| in=huge out=short (65536t / 64t) | 2.1 | 2.5 | 2.5 | 2.4 | 2.4 | 2.4 | 2.4 | 2.2 |
| in=huge out=medium (65536t / 512t) | 18.4 | 28.4 | 29.3 | 29.4 | 28.5 | 29.2 | 29.0 | 28.3 |
| in=huge out=long (65536t / 2048t) | 28.8 | 56.0 | 56.9 | 53.4 | 51.8 | 54.2 | 52.6 | 55.3 |

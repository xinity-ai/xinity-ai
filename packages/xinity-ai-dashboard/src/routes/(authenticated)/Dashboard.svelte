<script lang="ts">
  import Chart from "$lib/components/Chart.svelte";
  import type { ChartConfiguration } from "chart.js";
  import type { KeyMetrics, ChartsData, TablesData } from "./dashboard.types";

  export let keyMetrics: Promise<KeyMetrics>;
  export let charts: Promise<ChartsData>;
  export let tables: Promise<TablesData>;

  function getLast30Days() {
    const dates = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      dates.push(date.getDate() + "/" + (date.getMonth() + 1));
    }
    return dates;
  }

  function formatDate(dateString: string) {
    const date = new Date(dateString);
    return date.toLocaleString();
  }

  function formatTokenAvg(val: number | null): string {
    if (val == null) return "-";
    if (val >= 1000) return (val / 1000).toFixed(1) + "k";
    return String(val);
  }

  function formatTokens(val: number): string {
    if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
    if (val >= 1000) return (val / 1000).toFixed(1) + "k";
    return String(val);
  }

  function formatDuration(ms: number | null): string {
    if (ms == null) return "\u2014";
    return (ms / 1000).toFixed(1) + "s";
  }
</script>

<div class="p-6 compact:p-3">
  <h1 class="text-3xl font-bold mb-6 compact:mb-3">Xinity Summary</h1>

  <!-- Key metrics cards -->
  {#await keyMetrics}
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 compact:gap-2 mb-6 compact:mb-3">
      {#each Array(4) as _}
        <div class="bg-white rounded-lg shadow p-5 compact:p-3 animate-pulse">
          <div class="h-4 bg-gray-200 rounded w-24 mb-2"></div>
          <div class="h-8 bg-gray-200 rounded w-16 mb-2"></div>
          <div class="h-3 bg-gray-100 rounded w-32 mt-2"></div>
        </div>
      {/each}
    </div>
  {:then { apiCallStats, tokenStats, trainingData }}
    {@const loggedPercent = apiCallStats.totalCalls > 0
      ? Math.round((apiCallStats.loggedCalls / apiCallStats.totalCalls) * 100)
      : 0}
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 compact:gap-2 mb-6 compact:mb-3">
      <div class="bg-white rounded-lg shadow p-5 compact:p-3">
        <p class="text-sm text-gray-500 mb-1">Total API Calls</p>
        <p class="text-2xl font-bold">{apiCallStats.totalCalls}</p>
        <p class="text-xs text-green-600 mt-2">
          +{apiCallStats.todayCalls} today &middot; {loggedPercent}% logged
        </p>
      </div>

      <div class="bg-white rounded-lg shadow p-5 compact:p-3">
        <p class="text-sm text-gray-500 mb-1">Avg Tokens / Call</p>
        <div class="mt-1 space-y-1">
          <div>
            <p class="text-xs text-gray-400 mb-0.5">Input</p>
            <div class="flex items-baseline gap-3">
              <div>
                <span class="text-xl font-bold">{formatTokenAvg(tokenStats.avgInput1h)}</span>
                <span class="text-xs text-gray-400 ml-0.5">1h</span>
              </div>
              <div>
                <span class="text-base font-semibold text-gray-600">{formatTokenAvg(tokenStats.avgInput10m)}</span>
                <span class="text-xs text-gray-400 ml-0.5">10m</span>
              </div>
              <div>
                <span class="text-base font-semibold text-gray-600">{formatTokenAvg(tokenStats.avgInput1m)}</span>
                <span class="text-xs text-gray-400 ml-0.5">1m</span>
              </div>
            </div>
          </div>
          <div>
            <p class="text-xs text-gray-400 mb-0.5">Output</p>
            <div class="flex items-baseline gap-3">
              <div>
                <span class="text-xl font-bold">{formatTokenAvg(tokenStats.avgOutput1h)}</span>
                <span class="text-xs text-gray-400 ml-0.5">1h</span>
              </div>
              <div>
                <span class="text-base font-semibold text-gray-600">{formatTokenAvg(tokenStats.avgOutput10m)}</span>
                <span class="text-xs text-gray-400 ml-0.5">10m</span>
              </div>
              <div>
                <span class="text-base font-semibold text-gray-600">{formatTokenAvg(tokenStats.avgOutput1m)}</span>
                <span class="text-xs text-gray-400 ml-0.5">1m</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow p-5 compact:p-3">
        <p class="text-sm text-gray-500 mb-1">Approval Rate</p>
        <p class="text-2xl font-bold">{apiCallStats.approvalRate}%</p>
        <p class="text-xs text-gray-400 mt-2">
          Avg response: {apiCallStats.avgResponseTime}s
        </p>
      </div>

      <div class="bg-white rounded-lg shadow p-5 compact:p-3">
        <p class="text-sm text-gray-500 mb-1">Training Datapoints</p>
        <p class="text-2xl font-bold">{trainingData.datapoints}</p>
        <p class="text-xs text-xinity-magenta mt-2">
          {trainingData.edited}% edited, {trainingData.rated}% rated
        </p>
      </div>
    </div>
  {/await}

  <!-- Main dashboard content (3-column grid) -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 compact:gap-3">
    <!-- Usage Trend Chart (col-span-2) -->
    {#await charts}
      <div class="bg-white rounded-lg shadow p-5 compact:p-3 lg:col-span-2 animate-pulse">
        <div class="h-5 bg-gray-200 rounded w-48 mb-4"></div>
        <div class="h-80 bg-gray-100 rounded"></div>
      </div>
    {:then { usageTrend }}
      <div class="bg-white rounded-lg shadow p-5 compact:p-3 lg:col-span-2">
        <h2 class="text-lg font-medium mb-4 compact:mb-2">Usage Trend (30 days)</h2>
        <div class="h-80">
          <Chart
            className="size-full"
            config={{
              type: "line",
              data: {
                labels: getLast30Days(),
                datasets: [
                  {
                    label: "Total Calls",
                    data: usageTrend.map(d => d.totalCalls),
                    backgroundColor: "rgba(160, 32, 240, 0.2)",
                    borderColor: "rgba(160, 32, 240, 1)",
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 3,
                    pointBackgroundColor: "rgba(160, 32, 240, 1)",
                    yAxisID: "y",
                  },
                  {
                    label: "Logged Calls",
                    data: usageTrend.map(d => d.loggedCalls),
                    backgroundColor: "rgba(160, 32, 240, 0.05)",
                    borderColor: "rgba(160, 32, 240, 0.4)",
                    borderWidth: 2,
                    borderDash: [5, 5],
                    tension: 0.3,
                    pointRadius: 2,
                    pointBackgroundColor: "rgba(160, 32, 240, 0.4)",
                    yAxisID: "y",
                  },
                  {
                    label: "Input Tokens",
                    data: usageTrend.map(d => d.inputTokens),
                    backgroundColor: "rgba(214, 51, 132, 0.1)",
                    borderColor: "rgba(214, 51, 132, 0.8)",
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 2,
                    pointBackgroundColor: "rgba(214, 51, 132, 0.8)",
                    yAxisID: "y1",
                  },
                  {
                    label: "Output Tokens",
                    data: usageTrend.map(d => d.outputTokens),
                    backgroundColor: "rgba(232, 96, 74, 0.1)",
                    borderColor: "rgba(232, 96, 74, 0.8)",
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 2,
                    pointBackgroundColor: "rgba(232, 96, 74, 0.8)",
                    yAxisID: "y1",
                  },
                ],
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                  mode: "index",
                  intersect: false,
                },
                scales: {
                  y: {
                    type: "linear",
                    position: "left",
                    beginAtZero: true,
                    title: {
                      display: true,
                      text: "Calls",
                    },
                    border: {
                      display: false,
                    },
                  },
                  y1: {
                    type: "linear",
                    position: "right",
                    beginAtZero: true,
                    title: {
                      display: true,
                      text: "Tokens",
                    },
                    grid: {
                      drawOnChartArea: false,
                    },
                  },
                  x: {
                    grid: {
                      display: false,
                    },
                  },
                },
                plugins: {
                  legend: {
                    display: true,
                    position: "bottom",
                  },
                },
              },
            }}
          />
        </div>
      </div>
    {/await}

    <!-- Response Rating Chart -->
    {#await keyMetrics}
      <div class="bg-white rounded-lg shadow p-5 compact:p-3 animate-pulse">
        <div class="h-5 bg-gray-200 rounded w-36 mb-4"></div>
        <div class="h-80 bg-gray-100 rounded"></div>
      </div>
    {:then { responseRatings }}
      <div class="bg-white rounded-lg shadow p-5 compact:p-3">
        <h2 class="text-lg font-medium mb-4 compact:mb-2">Response Ratings</h2>
        <div class="h-80">
          <Chart
            className="size-full"
            config={{
              type: "doughnut",
              data: {
                labels: ["Liked", "Disliked", "Unrated"],
                datasets: [
                  {
                    data: [
                      responseRatings.liked,
                      responseRatings.disliked,
                      responseRatings.unrated,
                    ],
                    backgroundColor: [
                      "rgba(160, 32, 240, 0.6)",
                      "rgba(232, 96, 74, 0.6)",
                      "rgba(209, 213, 219, 0.6)",
                    ],
                    borderColor: [
                      "rgba(160, 32, 240, 1)",
                      "rgba(232, 96, 74, 1)",
                      "rgba(209, 213, 219, 1)",
                    ],
                    borderWidth: 1,
                  },
                ],
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: "60%",
                plugins: {
                  legend: {
                    position: "bottom",
                  },
                },
              },
            } satisfies ChartConfiguration<"doughnut"> as ChartConfiguration}
          />
        </div>
      </div>
    {/await}

    <!-- Application Usage Chart -->
    {#await charts}
      <div class="bg-white rounded-lg shadow p-5 compact:p-3 animate-pulse">
        <div class="h-5 bg-gray-200 rounded w-36 mb-4"></div>
        <div class="h-80 bg-gray-100 rounded"></div>
      </div>
    {:then { topApplications }}
      <div class="bg-white rounded-lg shadow p-5 compact:p-3">
        <h2 class="text-lg font-medium mb-4 compact:mb-2">Application Usage</h2>
        <div class="h-80">
          <Chart
            className="size-full"
            config={{
              type: "bar",
              data: {
                labels: topApplications.map((app) => app.name),
                datasets: [
                  {
                    label: "Calls (30 days)",
                    data: topApplications.map((app) => app.totalCalls),
                    backgroundColor: "rgba(160, 32, 240, 0.6)",
                    borderColor: "rgba(160, 32, 240, 1)",
                    borderWidth: 1,
                    borderRadius: 4,
                  },
                ],
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                  y: {
                    beginAtZero: true,
                    border: {
                      display: false,
                    },
                  },
                  x: {
                    grid: {
                      display: false,
                    },
                  },
                },
              },
            }}
          />
        </div>
      </div>
    {/await}

    <!-- Recent Activities -->
    {#await tables}
      <div class="bg-white rounded-lg shadow p-5 compact:p-3 lg:col-span-2 animate-pulse">
        <div class="h-5 bg-gray-200 rounded w-36 mb-4"></div>
        <div class="space-y-3">
          {#each Array(5) as _}
            <div class="h-10 bg-gray-100 rounded"></div>
          {/each}
        </div>
      </div>
      <div class="bg-white rounded-lg shadow p-5 compact:p-3 animate-pulse">
        <div class="h-5 bg-gray-200 rounded w-36 mb-4"></div>
        <div class="space-y-3">
          {#each Array(3) as _}
            <div class="h-14 bg-gray-100 rounded"></div>
          {/each}
        </div>
      </div>
    {:then { recentActivities, recentModels }}
      <div class="bg-white rounded-lg shadow p-5 compact:p-3 lg:col-span-2">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-lg font-medium">Recent Activities</h2>
          <a href="/data" class="text-sm text-xinity-magenta hover:text-xinity-pink">View All</a>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
              <tr>
                <th scope="col" class="px-6 py-3 compact:py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Model</th>
                <th scope="col" class="px-6 py-3 compact:py-1.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Input Tokens</th>
                <th scope="col" class="px-6 py-3 compact:py-1.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Output Tokens</th>
                <th scope="col" class="px-6 py-3 compact:py-1.5 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                <th scope="col" class="px-6 py-3 compact:py-1.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                <th scope="col" class="px-6 py-3 compact:py-1.5 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Logged</th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              {#each recentActivities as activity}
                <tr>
                  <td class="px-6 py-4 compact:py-2 whitespace-nowrap">
                    <div class="text-sm font-medium text-gray-900">{activity.model}</div>
                  </td>
                  <td class="px-6 py-4 compact:py-2 whitespace-nowrap text-right">
                    <div class="text-sm text-gray-500">{formatTokens(activity.inputTokens)}</div>
                  </td>
                  <td class="px-6 py-4 compact:py-2 whitespace-nowrap text-right">
                    <div class="text-sm text-gray-500">{formatTokens(activity.outputTokens)}</div>
                  </td>
                  <td class="px-6 py-4 compact:py-2 whitespace-nowrap text-right">
                    <div class="text-sm text-gray-500">{formatDuration(activity.duration)}</div>
                  </td>
                  <td class="px-6 py-4 compact:py-2 whitespace-nowrap">
                    <div class="text-sm text-gray-500">{formatDate(activity.timestamp)}</div>
                  </td>
                  <td class="px-6 py-4 compact:py-2 whitespace-nowrap text-center">
                    {#if activity.logged}
                      <span class="inline-block h-2 w-2 rounded-full bg-green-500" title="Logged"></span>
                    {:else}
                      <span class="inline-block h-2 w-2 rounded-full bg-gray-300" title="Not logged"></span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow p-5 compact:p-3">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-lg font-medium">Deployed Models</h2>
          <a href="/modelhub" class="text-sm text-xinity-magenta hover:text-xinity-pink">View All</a>
        </div>
        <div class="space-y-3 compact:space-y-1">
          {#each recentModels as model}
            <div class="flex items-center justify-between p-3 compact:p-2 border rounded-lg hover:bg-gray-50">
              <div class="flex items-center">
                <div class="ml-3">
                  <p class="text-sm font-medium text-gray-900">{model.name}</p>
                  <div class="flex items-center mt-1">
                    <span class="h-2 w-2 rounded-full bg-green-500 mr-1.5"></span>
                    <p class="text-xs text-gray-500 capitalize">{model.status}</p>
                  </div>
                </div>
              </div>
              <a href="/modelhub" class="text-sm text-xinity-magenta hover:text-xinity-pink">Details</a>
            </div>
          {/each}
        </div>
        <div class="mt-4 text-center">
          <a
            href="/training"
            class="inline-flex items-center px-4 py-2 border border-xinity-purple text-sm font-medium rounded-md text-xinity-magenta bg-white hover:bg-xinity-magenta/10"
          >
            Train New Model
          </a>
        </div>
      </div>
    {/await}
  </div>
</div>

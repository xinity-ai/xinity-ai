export type ChecklistData = {
  hasOrganization: boolean;
  hasDeployment: boolean;
  hasApiCall: boolean;
  hasLabeledCall: boolean;
  hasInvitation: boolean;
  hasApplication: boolean;
};

export type ApiCallStats = {
  totalCalls: number;
  loggedCalls: number;
  todayCalls: number;
  todayLoggedCalls: number;
  approvalRate: number;
  avgResponseTime: number;
};

export type TokenStats = {
  avgInput1m: number | null;
  avgOutput1m: number | null;
  avgInput10m: number | null;
  avgOutput10m: number | null;
  avgInput1h: number | null;
  avgOutput1h: number | null;
};

export type ResponseRatings = {
  liked: number;
  disliked: number;
  unrated: number;
};

export type TrainingData = {
  datapoints: number;
  edited: number;
  rated: number;
};

export type UsageTrendEntry = {
  totalCalls: number;
  loggedCalls: number;
  inputTokens: number;
  outputTokens: number;
};

export type TopApplication = {
  name: string;
  totalCalls: number;
  totalTokens: number;
};

export type RecentActivity = {
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  duration: number | null;
  logged: boolean;
};

export type RecentModel = {
  name: string;
  status: string;
};

export type KeyMetrics = {
  apiCallStats: ApiCallStats;
  tokenStats: TokenStats;
  responseRatings: ResponseRatings;
  trainingData: TrainingData;
};

export type ChartsData = {
  usageTrend: UsageTrendEntry[];
  topApplications: TopApplication[];
};

export type TablesData = {
  recentActivities: RecentActivity[];
  recentModels: RecentModel[];
};

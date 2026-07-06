export type SearchResult = {
  title: string;
  url: string;
  content?: string;
};

export type SearchProvider = {
  search(query: string, maxResults: number): Promise<SearchResult[]>;
};

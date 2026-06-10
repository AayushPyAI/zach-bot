export interface RedditPost {
  id: string;
  subreddit: string;
  title: string;
  body: string;
  author: string;
  url: string;
  permalink: string;
  createdUtc: number;
  commentCount: number;
  upvotes: number;
  over18: boolean;
  locked: boolean;
  archived: boolean;
  isSelf: boolean;
  /** Audience group this post was discovered under (set during discovery). */
  audience?: string;
}

export interface AnalysisResult {
  relevance: number;
  /** 0-10: how strongly the post is actively seeking advice/recommendations (buying intent). */
  intent: number;
  /** 0-10: the model's self-rating of how genuinely valuable/specific the drafted reply is. */
  quality: number;
  reason: string;
  draftComment: string | null;
}

/** One product distilled from the client's website, used to steer comments. */
export interface CatalogProduct {
  name: string;
  description: string;
  /** Best-fit audience label, aligned with the config `audiences` groups. */
  audience: string;
  topics: string[];
  /** Short, topical angles a helpful commenter could naturally raise. */
  talkingPoints: string[];
}

export interface ProductCatalog {
  source: string;
  generatedAt: string;
  products: CatalogProduct[];
}

export interface StoredPost extends RedditPost {
  firstSeenTs: number;
  relevance: number | null;
  intent: number | null;
  reason: string | null;
  draftComment: string | null;
  commented: boolean;
  commentedTs: number | null;
  dryRun: boolean;
  skippedReason: string | null;
}

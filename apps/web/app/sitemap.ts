import type { MetadataRoute } from "next";
import { toAbsoluteUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    {
      url: toAbsoluteUrl("/"),
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: toAbsoluteUrl("/settings"),
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
  ];
}

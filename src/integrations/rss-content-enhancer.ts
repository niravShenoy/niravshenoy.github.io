import type { AstroIntegration } from 'astro';
import * as fs from 'fs/promises';
import * as path from 'path';
import sanitizeHtml from 'sanitize-html';
import { parseStringPromise, Builder } from 'xml2js';
import { LAST_BUILD_TIME } from "../constants";

const rssContentEnhancer = (): AstroIntegration => {
  return {
    name: 'rss-content-enhancer',
    hooks: {
      'astro:build:done': async () => {
        const distDir = 'dist';
        const tempDir = './tmp/rss-cache';
        const rssPath = path.join(distDir, 'rss.xml');

        // Create temp directory if it doesn't exist
        await fs.mkdir(tempDir, { recursive: true });

        // Read and parse RSS XML
        const rssContent = await fs.readFile(rssPath, 'utf-8');
        const rssData = await parseStringPromise(rssContent);

        // Extract base URL from channel link
        const baseUrl = rssData.rss.channel[0].link[0].replace(/\/$/, ''); // Remove trailing slash if present

        // Process each item
        for (const item of rssData.rss.channel[0].item) {
          const encodedSlug = item.link[0].split('/').pop();
          const slug = decodeURIComponent(encodedSlug);
          const htmlPath = path.join(distDir, 'posts', slug, 'index.html');

          try {
            const htmlContent = await fs.readFile(htmlPath, 'utf-8');

            // Extract last updated timestamp from title
            const lastUpdatedMatch = item.title[0].match(/<!--lastUpdated:(.+?)-->/);
            const lastUpdated = lastUpdatedMatch ? new Date(lastUpdatedMatch[1]) : null;

            // Clean up the title by removing the timestamp
            item.title = [item.title[0].replace(/<!--lastUpdated:.+?-->/, '').trim()];

            // Check cache
            const cachePath = path.join(tempDir, `${slug}.html`);
            let shouldUpdate = true;

            // Check if cache exists
            try {
              await fs.access(cachePath);

              // If cache exists and LAST_BUILD_TIME exists, use it to determine if we need to update
              if (LAST_BUILD_TIME) {
                const lastBuildTime = new Date(LAST_BUILD_TIME);
                shouldUpdate = !lastUpdated || lastUpdated > lastBuildTime;
              }
            } catch {
              // Cache doesn't exist, need to sanitize
              shouldUpdate = true;
            }

            if (shouldUpdate) {
              // Extract main content (assuming it's in <main> tag)
              const mainMatch = htmlContent.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
              if (mainMatch) {
                const mainContent = mainMatch[1];

                // Remove autogenerated sections
                const contentWithoutExtra = mainContent
                  .replace(/<div[^>]*id="autogenerated-post-comments"[^>]*>[\s\S]*?<\/div>/i, '')
                  .replace(/<div[^>]*id="autogenerated-media-links"[^>]*>[\s\S]*?<\/div>/i, '')
                  .replace(/<details[^>]*id="autogenerated-external-links"[^>]*>[\s\S]*?<\/details>/i, '');

                // Sanitize HTML and fix image paths
                const cleanContent = sanitizeHtml(contentWithoutExtra, {
                  allowedTags: [
                    // Document sections
                    'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4',
                    'h5', 'h6', 'hgroup', 'main', 'nav', 'section',

                    // Block text content
                    'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'hr',
                    'li', 'main', 'ol', 'p', 'pre', 'ul',

                    // Inline text
                    'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn',
                    'em', 'i', 'kbd', 'mark', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby', 's',
                    'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
                    'wbr',

                    // Table content
                    'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th',
                    'thead', 'tr',

                    // Images
                    'img'
                  ],
                  allowedAttributes: {
                    'a': ['href', 'title', 'target'],
                    'img': ['src', 'alt', 'title'],
                    'td': ['align', 'valign'],
                    'th': ['align', 'valign', 'colspan', 'rowspan'],
                    'span': ['data-popover-target','data-href']
                  },
                  transformTags: {
                    img: (tagName, attribs) => {
                      // Remove Notion icon images
                      if (attribs.src?.startsWith('https://www.notion.so/icons/')) {
                        return { tagName: '', attribs: {} };
                      }
                      // Remove custom emoji images
                      if (attribs.alt?.startsWith('custom emoji with name ')) {
                        return { tagName: '', attribs: {} };
                      }
                      if (attribs.src && attribs.src.startsWith('/notion/')) {
                        return {
                          tagName,
                          attribs: {
                            ...attribs,
                            src: `${baseUrl}${attribs.src}`
                          }
                        };
                      }
                      return { tagName, attribs };
                    },
                    span: (tagName, attribs, innerHTML = '') => {
                      // Remove empty spans unless they have specific attributes we want to keep
                      if (!innerHTML.trim() && !attribs['data-popover-target']) {
                        return { tagName: '', attribs: {} };
                      }

                      // If it's a popover span
                      if (attribs['data-popover-target']) {
                        const href = attribs['data-href'];

                        // Remove spans that link to anchors
                        if (href?.startsWith('#')) {
                          return { tagName: '', attribs: {} };
                        }

                        // Convert to link if it's a post link
                        if (href?.startsWith('/posts/')) {
                          // Remove sr-only span from content
                          const cleanContent = innerHTML.replace(/<span class="sr-only">.*?<\/span>/g, '').trim();

                          return {
                            tagName: 'a',
                            attribs: {
                              href: `${baseUrl}${href}`
                            },
                            text: cleanContent || href // fallback to href if content is empty
                          };
                        }
                      }

                      // Keep non-empty spans
                      return innerHTML.trim() ? { tagName, attribs } : { tagName: '', attribs: {} };
                    },
                    div: (tagName, attribs, innerHTML = '') => {
                      // Remove empty divs
                      return innerHTML.trim() ? { tagName, attribs } : { tagName: '', attribs: {} };
                    }
                  },
                  exclusiveFilter: function(frame) {
                    // Remove any remaining empty elements except specific ones
                    const keepTags = ['br', 'hr', 'img'];
                    return !keepTags.includes(frame.tag) && !frame.text.trim() && !Object.keys(frame.attribs).length;
                  }
                });

                // Remove the first h1 (title)
                const contentWithoutTitle = cleanContent.replace(/<h1[^>]*>.*?<\/h1>/i, '');

                // Wrap the content in article structure
                const wrappedContent = `
                  <div class="-feed-entry-content">
                    ${contentWithoutTitle}
                  </div>`;

                // Cache the cleaned content
                await fs.writeFile(cachePath, wrappedContent);

                // Add content tag to RSS item
                item.content = [wrappedContent];

                // If description is empty, generate from content
                if (!item.description?.[0]?.trim()) {
                  // Remove HTML tags and get plain text
                  const plainText = wrappedContent.replace(/<[^>]+>/g, '').trim();
                  // Get first 50 characters and add ellipsis
                  item.description = [plainText.slice(0, 50) + (plainText.length > 50 ? '...' : '')];
                }
              }
            } else {
              // Use cached version
              const cachedContent = await fs.readFile(cachePath, 'utf-8');
              item.content = [cachedContent];

              // If description is empty, generate from cached content
              if (!item.description?.[0]?.trim()) {
                const plainText = cachedContent.replace(/<[^>]+>/g, '').trim();
                item.description = [plainText.slice(0, 50) + (plainText.length > 50 ? '...' : '')];
              }
            }
          } catch (error) {
            console.error(`Error processing ${slug}:`, error);
          }
        }

        // Build and save the updated RSS
        const builder = new Builder({
          xmldec: { version: '1.0', encoding: 'UTF-8' },
          allowSurrogateChars: true
        });
        const updatedRss = builder.buildObject(rssData);

        // Add stylesheet processing instruction
        const styleSheet = rssContent.match(/<\?xml-stylesheet[^>]+\?>/)?.[0] || '';
        const finalXml = updatedRss.replace('?>', `?>${styleSheet}`);

        await fs.writeFile(rssPath, finalXml);
      }
    }
  };
};

export default rssContentEnhancer;

(function() {
    /**
     * StremioHub Plugin for SkyStream v1
     * 
     * Aggregates content from multiple Stremio add-ons.
     * Add/remove manifest.json URLs in plugin.json "addons" array.
     * First addon = highest priority in home feed.
     * 
     * @type {import('@skystream/sdk').Manifest}
     */

    // --- Constants ---
    const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.5"
    };

    // Cache for addon manifests (refresh each getHome call)
    let addonManifestsCache = null;
    let lastManifestFetch = 0;
    const MANIFEST_CACHE_TTL = 300000; // 5 minutes

    // --- URL Encoding/Decoding ---
    // URL format: JSON.stringify({ a: addonBaseUrl, t: type, i: id, s: season, e: episode })

    function encodeUrl(addonUrl, type, id, season, episode) {
        return JSON.stringify({
            a: addonUrl,
            t: type,
            i: id,
            s: season || 0,
            e: episode || 0
        });
    }

    function decodeUrl(url) {
        try {
            return JSON.parse(url);
        } catch (e) {
            return null;
        }
    }

    // --- HTTP Helper ---
    async function fetchJson(url, headers) {
        var mergedHeaders = Object.assign({}, HEADERS, headers || {});
        var res = await http_get(url, mergedHeaders);
        if (!res || !res.body) throw new Error("Empty response from " + url);
        if (res.status === 404) throw new Error("Not found: " + url);
        if (res.status !== 200) throw new Error("HTTP " + res.status + " from " + url);
        var body = res.body;
        // Check if response is HTML (site blocking)
        if (typeof body === "string" && body.trim().charAt(0) === "<") {
            throw new Error("HTML response (blocked) from " + url);
        }
        return JSON.parse(body);
    }

    async function fetchJsonSafe(url, headers) {
        try {
            return await fetchJson(url, headers);
        } catch (e) {
            return null;
        }
    }

    // --- Addon Management ---

    /** 
     * Get list of addon manifest URLs from plugin.json config.
     * Falls back to built-in defaults if none configured.
     */
    function getAddonUrls() {
        var urls = [];
        if (manifest && manifest.addons && Array.isArray(manifest.addons)) {
            manifest.addons.forEach(function(url) {
                if (url && typeof url === "string" && url.trim().length > 0) {
                    urls.push(url.trim());
                }
            });
        }
        return urls;
    }

    /**
     * Extract base URL from a manifest.json URL.
     * e.g. "https://example.com/manifest.json" => "https://example.com"
     */
    function getBaseUrl(manifestUrl) {
        return manifestUrl.replace(/\/manifest\.json$/, "").replace(/\/$/, "");
    }

    /**
     * Fetch addon manifests to get name, type, and catalog IDs.
     * Returns array of { name, baseUrl, type, catalogId, resources }
     * Cached for MANIFEST_CACHE_TTL.
     */
    async function getAddonConfigs() {
        var now = Date.now();
        if (addonManifestsCache && (now - lastManifestFetch) < MANIFEST_CACHE_TTL) {
            return addonManifestsCache;
        }

        var urls = getAddonUrls();
        var configs = [];

        // Fetch all manifests in parallel
        var results = await Promise.allSettled(urls.map(function(url) {
            return fetchJson(url, HEADERS).then(function(manifestData) {
                if (!manifestData) return null;
                var baseUrl = getBaseUrl(url);
                var name = manifestData.name || baseUrl;
                
                // Get catalogs
                var catalogs = manifestData.catalogs || [];
                if (catalogs.length === 0) {
                    // Try to infer from resources/types
                    var types = manifestData.types || ["movie"];
                    catalogs = types.map(function(t) {
                        return { type: t, id: t === "series" ? "top" : "1", name: name + " " + t };
                    });
                }

                return {
                    name: name,
                    baseUrl: baseUrl,
                    catalogs: catalogs,
                    types: manifestData.types || ["movie"],
                    idPrefixes: manifestData.idPrefixes || []
                };
            });
        }));

        results.forEach(function(result) {
            if (result.status === "fulfilled" && result.value) {
                configs.push(result.value);
            }
        });

        addonManifestsCache = configs;
        lastManifestFetch = now;
        return configs;
    }

    /**
     * Fetch catalog items from a specific addon catalog.
     */
    async function fetchCatalog(addonConfig, catalogEntry, limit) {
        var url = addonConfig.baseUrl + "/catalog/" + catalogEntry.type + "/" + catalogEntry.id + ".json";
        if (limit) {
            url += "?limit=" + limit;
        }
        var data = await fetchJsonSafe(url, HEADERS);
        if (!data || !data.metas) return [];
        return data.metas;
    }

    /**
     * Convert a Stremio meta item to a SkyStream MultimediaItem.
     */
    function metaToMultimediaItem(meta, addonConfig, catalogType) {
        if (!meta) return null;
        var type = meta.type || catalogType || "movie";
        // Map Stremio types to SkyStream types
        var skystreamType = "movie";
        if (type === "series" || type === "tv" || type === "anime" || type === "hentai") {
            skystreamType = "series";
        }
        
        var poster = meta.poster || "";
        var background = meta.background || meta.backdrop || "";

        return new MultimediaItem({
            title: meta.name || meta.title || "Unknown",
            url: encodeUrl(addonConfig.baseUrl, type, meta.id),
            posterUrl: poster,
            bannerUrl: background,
            type: skystreamType,
            description: (meta.description || "").replace(/<[^>]*>/g, "").trim(),
            year: meta.year || meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined,
            score: meta.score || meta.popularity || undefined
        });
    }

    // --- Core Functions ---

    /**
     * getHome: Fetches catalog from each configured addon in priority order.
     * First addon in the list = highest priority (appears first in home feed).
     * Each addon's first catalog is fetched and displayed as a section.
     * 
     * @param {Function} cb - Callback with { success, data }
     */
    async function getHome(cb) {
        try {
            var addonConfigs = await getAddonConfigs();
            if (addonConfigs.length === 0) {
                return cb({ success: false, errorCode: "NO_ADDONS", message: "No addons configured" });
            }

            var homeSections = {};
            var sectionOrder = [];

            // Fetch catalogs from each addon in priority order
            var catalogPromises = addonConfigs.map(function(config) {
                return (async function() {
                    var catalogs = config.catalogs;
                    if (catalogs.length === 0) return null;
                    
                    // Use the first catalog
                    var catalogEntry = catalogs[0];
                    var metas = await fetchCatalog(config, catalogEntry, 25);
                    if (!metas || metas.length === 0) return null;

                    var items = metas.map(function(meta) {
                        return metaToMultimediaItem(meta, config, catalogEntry.type);
                    }).filter(function(item) { return item !== null; });

                    if (items.length === 0) return null;

                    return {
                        name: config.name,
                        items: items
                    };
                })();
            });

            var catalogResults = await Promise.allSettled(catalogPromises);
            catalogResults.forEach(function(result) {
                if (result.status === "fulfilled" && result.value) {
                    homeSections[result.value.name] = result.value.items;
                    sectionOrder.push(result.value.name);
                }
            });

            if (Object.keys(homeSections).length === 0) {
                return cb({ success: false, errorCode: "NO_DATA", message: "No catalog data available from any addon" });
            }

            // Optionally sort sections to maintain priority order
            var orderedData = {};
            sectionOrder.forEach(function(name) {
                if (homeSections[name]) {
                    orderedData[name] = homeSections[name];
                }
            });
            // Add any remaining sections not in order
            Object.keys(homeSections).forEach(function(name) {
                if (!orderedData[name]) {
                    orderedData[name] = homeSections[name];
                }
            });

            cb({ success: true, data: orderedData });
        } catch (e) {
            console.error("getHome error:", e.message);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    /**
     * search: Searches across all configured addons.
     * Only addons that support search in their catalogs are queried.
     * 
     * @param {string} query - Search query
     * @param {Function} cb - Callback with { success, data }
     */
    async function search(query, cb) {
        try {
            var q = String(query || "").trim();
            if (!q) {
                return cb({ success: true, data: [] });
            }

            var addonConfigs = await getAddonConfigs();
            if (addonConfigs.length === 0) {
                return cb({ success: true, data: [] });
            }

            var allResults = [];
            var searchPromises = addonConfigs.map(function(config) {
                return (async function() {
                    var results = [];
                    var catalogs = config.catalogs;
                    
                    // Try each catalog that might support search
                    for (var c = 0; c < catalogs.length; c++) {
                        var cat = catalogs[c];
                        // Check if this catalog supports search
                        var hasSearch = false;
                        if (cat.extra) {
                            for (var x = 0; x < cat.extra.length; x++) {
                                if (cat.extra[x].name === "search") {
                                    hasSearch = true;
                                    break;
                                }
                            }
                        }
                        if (!hasSearch) continue;

                        var url = config.baseUrl + "/catalog/" + cat.type + "/" + cat.id + "/search=" + encodeURIComponent(q) + ".json";
                        var data = await fetchJsonSafe(url, HEADERS);
                        if (data && data.metas && data.metas.length > 0) {
                            data.metas.forEach(function(meta) {
                                var item = metaToMultimediaItem(meta, config, cat.type);
                                if (item) results.push(item);
                            });
                        }
                        // Only need results from one catalog per addon
                        if (results.length > 0) break;
                    }
                    return results;
                })();
            });

            var searchResults = await Promise.allSettled(searchPromises);
            searchResults.forEach(function(result) {
                if (result.status === "fulfilled" && result.value) {
                    allResults = allResults.concat(result.value);
                }
            });

            // Deduplicate by title (case-insensitive)
            var seen = {};
            allResults = allResults.filter(function(item) {
                var key = item.title.toLowerCase();
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            cb({ success: true, data: allResults });
        } catch (e) {
            console.error("search error:", e.message);
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message });
        }
    }

    /**
     * load: Fetches full metadata for a specific item from its source addon.
     * Decodes the URL to find which addon and content ID to query.
     * 
     * @param {string} url - Encoded URL from catalog item
     * @param {Function} cb - Callback with { success, data }
     */
    async function load(url, cb) {
        try {
            var decoded = decodeUrl(url);
            if (!decoded) {
                return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid URL format" });
            }

            var addonUrl = decoded.a;
            var type = decoded.t;
            var id = decoded.i;

            // Fetch meta from addon
            var metaUrl = addonUrl + "/meta/" + type + "/" + encodeURIComponent(id) + ".json";
            var data = await fetchJsonSafe(metaUrl, HEADERS);

            if (data && data.meta) {
                var meta = data.meta;
                var skystreamType = "movie";
                if (type === "series" || type === "tv" || type === "anime" || type === "hentai") {
                    skystreamType = "series";
                }

                // Build episodes from meta.videos if available
                var episodes = [];
                if (meta.videos && Array.isArray(meta.videos)) {
                    meta.videos.forEach(function(video) {
                        episodes.push(new Episode({
                            name: video.title || video.name || "Episode " + (video.episode || video.number || 1),
                            url: encodeUrl(addonUrl, type, video.id || id, video.season || 1, video.episode || video.number || 1),
                            season: video.season || 1,
                            episode: video.episode || video.number || 1,
                            posterUrl: video.thumbnail || meta.poster || "",
                            description: video.description || meta.description || "",
                            airDate: video.released || ""
                        }));
                    });
                }

                // If no episodes from videos, create a single episode for the whole item
                if (episodes.length === 0) {
                    episodes.push(new Episode({
                        name: skystreamType === "movie" ? "Full Movie" : "Watch",
                        url: url,
                        season: 1,
                        episode: 1,
                        posterUrl: meta.poster || "",
                        description: (meta.description || "").replace(/<[^>]*>/g, "").trim()
                    }));
                }

                var multimediaItem = new MultimediaItem({
                    title: meta.name || meta.title || meta.englishName || "Unknown",
                    url: url,
                    posterUrl: meta.poster || "",
                    bannerUrl: meta.background || meta.backdrop || "",
                    logoUrl: meta.logo || "",
                    type: skystreamType,
                    description: (meta.description || "").replace(/<[^>]*>/g, "").trim(),
                    year: meta.year || meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined,
                    score: meta.score || undefined,
                    genres: meta.genres || meta.tags || undefined,
                    status: meta.status ? (meta.status.toLowerCase().includes("releasing") || meta.status.toLowerCase().includes("ongoing") ? "ongoing" : "completed") : undefined,
                    episodes: episodes
                });

                return cb({ success: true, data: multimediaItem });
            }

            // Fallback: If no meta endpoint, create basic item from decoded info
            cb({
                success: true,
                data: new MultimediaItem({
                    title: "Content",
                    url: url,
                    type: type === "series" || type === "anime" ? "series" : "movie",
                    episodes: [new Episode({
                        name: type === "movie" ? "Full Movie" : "Watch",
                        url: url,
                        season: 1,
                        episode: 1
                    })]
                })
            });
        } catch (e) {
            console.error("load error:", e.message);
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    /**
     * loadStreams: Fetches playable stream URLs from the source addon.
     * Decodes the URL to find which addon and content ID to query.
     * Supports both movie and series (with season/episode) formats.
     * 
     * @param {string} url - Encoded URL from episode
     * @param {Function} cb - Callback with { success, data }
     */
    async function loadStreams(url, cb) {
        try {
            var decoded = decodeUrl(url);
            if (!decoded) {
                // Try direct URL as fallback
                return cb({ success: true, data: [new StreamResult({
                    url: url,
                    quality: "Auto",
                    source: "Direct",
                    headers: HEADERS
                })] });
            }

            var addonUrl = decoded.a;
            var type = decoded.t;
            var id = decoded.i;
            var season = decoded.s;
            var episode = decoded.e;

            // Build stream URL based on Stremio protocol
            var streamUrl;
            if ((type === "series" || type === "anime" || type === "hentai") && season > 0 && episode > 0) {
                // Series format: /stream/{type}/{id}:{season}:{episode}.json
                streamUrl = addonUrl + "/stream/" + type + "/" + encodeURIComponent(id) + ":" + season + ":" + episode + ".json";
            } else {
                // Movie format: /stream/{type}/{id}.json
                streamUrl = addonUrl + "/stream/" + type + "/" + encodeURIComponent(id) + ".json";
            }

            var data = await fetchJsonSafe(streamUrl, HEADERS);
            var streams = [];

            if (data && data.streams && Array.isArray(data.streams)) {
                data.streams.forEach(function(stream) {
                    if (!stream.url && !stream.infoHash && !stream.ytId) return;

                    var quality = extractQuality(stream.name || stream.title || stream.description || stream.url || "");
                    var sourceName = extractSourceName(addonUrl);

                    // Handle direct URLs (HLS/MP4)
                    if (stream.url) {
                        var headers = {};
                        if (stream.behaviorHints) {
                            if (stream.behaviorHints.proxyHeaders && stream.behaviorHints.proxyHeaders.request) {
                                headers = stream.behaviorHints.proxyHeaders.request;
                            } else if (stream.behaviorHints.headers) {
                                headers = stream.behaviorHints.headers;
                            }
                        }
                        if (!headers["User-Agent"]) {
                            headers["User-Agent"] = USER_AGENT;
                        }

                        streams.push(new StreamResult({
                            url: stream.url,
                            quality: quality,
                            source: sourceName + " " + (stream.name || ""),
                            headers: headers,
                            subtitles: stream.subtitles ? stream.subtitles.map(function(sub) {
                                return { url: sub.url, lang: sub.lang || "Unknown" };
                            }) : undefined
                        }));
                    }

                    // Handle torrent infoHash (some addons return torrents)
                    if (stream.infoHash) {
                        var torrentUrl = "magnet:?xt=urn:btih:" + stream.infoHash;
                        if (stream.fileIdx !== undefined) {
                            torrentUrl += "&fileIdx=" + stream.fileIdx;
                        }
                        streams.push(new StreamResult({
                            url: torrentUrl,
                            quality: quality,
                            source: sourceName + " Torrent",
                            headers: { "User-Agent": USER_AGENT }
                        }));
                    }

                    // Handle YouTube
                    if (stream.ytId) {
                        streams.push(new StreamResult({
                            url: "https://www.youtube.com/watch?v=" + stream.ytId,
                            quality: "YouTube",
                            source: "YouTube",
                            headers: { "Referer": "https://www.youtube.com/" }
                        }));
                    }
                });
            }

            if (streams.length === 0) {
                // Return a placeholder so the user knows the addon was queried
                streams.push(new StreamResult({
                    url: "",
                    quality: "N/A",
                    source: extractSourceName(addonUrl) + " - No streams available",
                    headers: {}
                }));
            }

            cb({ success: true, data: streams });
        } catch (e) {
            console.error("loadStreams error:", e.message);
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message });
        }
    }

    // --- Helper Functions ---

    /**
     * Extract quality label from text.
     */
    function extractQuality(str) {
        if (!str) return "Auto";
        var s = String(str).toLowerCase();
        if (/\b(2160|4k|uhd)\b/.test(s)) return "4K";
        if (/\b1440\b/.test(s)) return "1440p";
        if (/\b1080\b/.test(s)) return "1080p";
        if (/\b720\b/.test(s)) return "720p";
        if (/\b480\b/.test(s)) return "480p";
        if (/\b360\b/.test(s)) return "360p";
        return "Auto";
    }

    /**
     * Extract a human-readable source name from an addon URL.
     */
    function extractSourceName(addonUrl) {
        try {
            var hostname = new URL(addonUrl).hostname;
            // Remove common prefixes
            return hostname.replace(/^www\./, "").split(".")[0];
        } catch (e) {
            return "Addon";
        }
    }

    // --- Export Functions ---
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();

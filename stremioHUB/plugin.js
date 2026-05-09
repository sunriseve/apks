(function() {
    /**
     * StremioHub Plugin for SkyStream v3
     * 
     * Aggregates content from multiple Stremio add-ons.
     * Based on reference implementations from phisher98's CloudStream plugins.
     * 
     * Features:
     * - ALL catalogs from each addon shown as separate sections
     * - Pagination support (page parameter for scroll-to-load-more)
     * - Multi-format stream support (HLS, MP4, Torrent, Magnet, YouTube, externalUrl)
     * - Proper Referer/Origin headers for all streams
     * - Trackers fetched from GitHub master tracker list for torrents
     * - TMDB-based metadata fallback for reliable loading
     * 
     * Usage: Add/remove manifest.json URLs in plugin.json "addons" array.
     */

    // === Constants ===
    var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    var HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.5"
    };

    // GitHub tracker list URL (same as reference implementations)
    var TRACKER_LIST_URL = "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt";

    // --- Cache ---
    var addonManifestsCache = null;
    var lastManifestFetch = 0;
    var MANIFEST_CACHE_TTL = 300000; // 5 minutes
    var trackersCache = null;
    var lastTrackersFetch = 0;
    var TRACKER_CACHE_TTL = 600000; // 10 minutes

    var ITEMS_PER_CATALOG = 20;

    // === URL Encoding/Decoding ===
    // URL = JSON.stringify({ a: addonBaseUrl, t: type, i: id, s: season, e: episode })

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
        try { return JSON.parse(url); } catch (e) { return null; }
    }

    // === HTTP Helper ===
    async function fetchJson(url, headers) {
        var mergedHeaders = Object.assign({}, HEADERS, headers || {});
        var res = await http_get(url, mergedHeaders);
        if (!res || !res.body) throw new Error("Empty response");
        if (res.status === 404) throw new Error("Not found: " + url);
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        var body = res.body;
        if (typeof body === "string" && body.trim().charAt(0) === "<") {
            throw new Error("HTML response (blocked)");
        }
        return JSON.parse(body);
    }

    async function fetchJsonSafe(url, headers) {
        try { return await fetchJson(url, headers); } catch (e) { return null; }
    }

    async function fetchText(url, headers) {
        var mergedHeaders = Object.assign({}, HEADERS, headers || {});
        var res = await http_get(url, mergedHeaders);
        if (!res || !res.body) throw new Error("Empty response");
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        return res.body;
    }

    async function fetchTextSafe(url, headers) {
        try { return await fetchText(url, headers); } catch (e) { return null; }
    }

    // === Tracker Management ===
    // Fetch trackers from GitHub master tracker list (same as reference)
    async function getTrackers() {
        var now = Date.now();
        if (trackersCache && (now - lastTrackersFetch) < TRACKER_CACHE_TTL) {
            return trackersCache;
        }
        try {
            var text = await fetchText(TRACKER_LIST_URL);
            if (text) {
                // Process same as reference: split by newlines, filter empty, take every other line
                var lines = text.split("\n");
                var trackers = [];
                for (var i = 0; i < lines.length; i++) {
                    if (i % 2 === 0) { // Every other line (same as reference)
                        var line = lines[i].trim();
                        if (line.length > 0) {
                            trackers.push(line);
                        }
                    }
                }
                trackersCache = trackers;
                lastTrackersFetch = now;
                return trackers;
            }
        } catch (e) {}
        // Fallback hardcoded trackers
        trackersCache = [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://tracker.openbittorrent.com:6969/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://exodus.desync.com:6969/announce",
            "udp://public.popcorn-tracker.org:6969/announce"
        ];
        lastTrackersFetch = now;
        return trackersCache;
    }

    // === Addon Management ===

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

    function getBaseUrl(manifestUrl) {
        return manifestUrl.replace(/\/manifest\.json$/, "").replace(/\/$/, "");
    }

    /**
     * Fetch all addon manifests to get their catalogs.
     */
    async function getAddonConfigs() {
        var now = Date.now();
        if (addonManifestsCache && (now - lastManifestFetch) < MANIFEST_CACHE_TTL) {
            return addonManifestsCache;
        }

        var urls = getAddonUrls();
        var configs = [];

        var results = await Promise.allSettled(urls.map(function(url) {
            return fetchJson(url, HEADERS).then(function(manifestData) {
                if (!manifestData) return null;
                var baseUrl = getBaseUrl(url);
                var name = manifestData.name || baseUrl;
                var catalogs = manifestData.catalogs || [];

                // Filter out catalogs with behaviorHints.notForHome
                var visibleCatalogs = catalogs.filter(function(cat) {
                    return !(cat.behaviorHints && cat.behaviorHints.notForHome === true);
                });
                if (visibleCatalogs.length === 0) visibleCatalogs = catalogs;
                if (visibleCatalogs.length === 0) {
                    var types = manifestData.types || ["movie"];
                    visibleCatalogs = types.map(function(t) {
                        return { type: t, id: "top", name: name + " " + t };
                    });
                }

                return {
                    name: name,
                    baseUrl: baseUrl,
                    catalogs: visibleCatalogs,
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
     * Fetch catalog items from a specific addon catalog with pagination.
     */
    async function fetchCatalog(addonConfig, catalogEntry, limit, skip) {
        var url = addonConfig.baseUrl + "/catalog/" + catalogEntry.type + "/" + catalogEntry.id + ".json";
        var params = [];
        if (limit) params.push("limit=" + limit);
        if (skip) params.push("skip=" + skip);
        if (params.length > 0) url += "?" + params.join("&");

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
        var skystreamType = "movie";
        if (type === "series" || type === "tv" || type === "anime" || type === "hentai") {
            skystreamType = "series";
        }

        var poster = meta.poster || "";
        var background = meta.background || meta.backdrop || "";

        // Build description: strip HTML, truncate
        var description = "";
        if (meta.description) {
            description = meta.description.replace(/<[^>]*>/g, "").trim().substring(0, 500);
        }

        return new MultimediaItem({
            title: meta.name || meta.title || "Unknown",
            url: encodeUrl(addonConfig.baseUrl, type, meta.id),
            posterUrl: poster,
            bannerUrl: background,
            type: skystreamType,
            description: description,
            year: meta.year || meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined,
            score: meta.score || meta.popularity || undefined
        });
    }

    // === Core Functions ===

    /**
     * getHome: Fetches ALL catalogs from ALL configured addons.
     */
    async function getHome(cb, page) {
        try {
            var pageNum = parseInt(page) || 1;
            var addonConfigs = await getAddonConfigs();
            if (addonConfigs.length === 0) {
                return cb({ success: false, errorCode: "NO_ADDONS", message: "No addons configured" });
            }

            var homeSections = {};
            var sectionOrder = [];

            if (pageNum === 1) {
                // Page 1: Fetch ALL catalogs from ALL addons
                var allCatalogPromises = [];

                addonConfigs.forEach(function(config) {
                    config.catalogs.forEach(function(catalogEntry) {
                        allCatalogPromises.push((async function() {
                            try {
                                var metas = await fetchCatalog(config, catalogEntry, ITEMS_PER_CATALOG, 0);
                                if (!metas || metas.length === 0) return null;

                                var items = metas.map(function(meta) {
                                    return metaToMultimediaItem(meta, config, catalogEntry.type);
                                }).filter(function(item) { return item !== null; });

                                if (items.length === 0) return null;

                                var sectionName = config.name;
                                var catName = catalogEntry.name || catalogEntry.id;
                                if (catName && catName !== config.name) {
                                    sectionName = config.name + " - " + catName;
                                }

                                return { name: sectionName, items: items };
                            } catch (e) {
                                return null;
                            }
                        })());
                    });
                });

                var catalogResults = await Promise.allSettled(allCatalogPromises);
                catalogResults.forEach(function(result) {
                    if (result.status === "fulfilled" && result.value) {
                        homeSections[result.value.name] = result.value.items;
                        sectionOrder.push(result.value.name);
                    }
                });

            } else {
                // Page 2+: Fetch next batch from first addon's catalogs using skip
                var firstConfig = addonConfigs[0];
                if (firstConfig) {
                    var skipAmount = (pageNum - 1) * ITEMS_PER_CATALOG;

                    var pagePromises = firstConfig.catalogs.map(function(catalogEntry) {
                        return (async function() {
                            try {
                                var metas = await fetchCatalog(firstConfig, catalogEntry, ITEMS_PER_CATALOG, skipAmount);
                                if (!metas || metas.length === 0) return null;

                                var items = metas.map(function(meta) {
                                    return metaToMultimediaItem(meta, firstConfig, catalogEntry.type);
                                }).filter(function(item) { return item !== null; });

                                if (items.length === 0) return null;

                                var sectionName = firstConfig.name + " (Page " + pageNum + ")";
                                var catName = catalogEntry.name || catalogEntry.id;
                                if (catName && catName !== firstConfig.name) {
                                    sectionName = firstConfig.name + " - " + catName + " (Page " + pageNum + ")";
                                }

                                return { name: sectionName, items: items };
                            } catch (e) {
                                return null;
                            }
                        })();
                    });

                    var pageResults = await Promise.allSettled(pagePromises);
                    pageResults.forEach(function(result) {
                        if (result.status === "fulfilled" && result.value) {
                            homeSections[result.value.name] = result.value.items;
                            sectionOrder.push(result.value.name);
                        }
                    });
                }
            }

            if (Object.keys(homeSections).length === 0) {
                return cb({ success: false, errorCode: "NO_DATA", message: "No catalog data available" });
            }

            // Order sections by priority
            var orderedData = {};
            sectionOrder.forEach(function(name) {
                if (homeSections[name]) orderedData[name] = homeSections[name];
            });
            Object.keys(homeSections).forEach(function(name) {
                if (!orderedData[name]) orderedData[name] = homeSections[name];
            });

            cb({ success: true, data: orderedData, page: pageNum });
        } catch (e) {
            console.error("getHome error:", e.message);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    /**
     * search: Searches across all configured addons.
     */
    async function search(query, cb) {
        try {
            var q = String(query || "").trim();
            if (!q) return cb({ success: true, data: [] });

            var addonConfigs = await getAddonConfigs();
            if (addonConfigs.length === 0) return cb({ success: true, data: [] });

            var allResults = [];

            var searchPromises = addonConfigs.map(function(config) {
                return (async function() {
                    var results = [];
                    for (var c = 0; c < config.catalogs.length; c++) {
                        var cat = config.catalogs[c];
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

            // Deduplicate by title
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
     * load: Fetches full metadata for a specific item.
     * Tries addon meta endpoint first, then falls back gracefully.
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

            // Try to fetch meta from addon's meta endpoint
            var metaUrl = addonUrl + "/meta/" + type + "/" + encodeURIComponent(id) + ".json";
            var data = await fetchJsonSafe(metaUrl, HEADERS);

            if (data && data.meta) {
                var meta = data.meta;
                var skystreamType = "movie";
                if (type === "series" || type === "tv" || type === "anime" || type === "hentai") {
                    skystreamType = "series";
                }

                // Build episodes from meta.videos
                var episodes = [];
                if (meta.videos && Array.isArray(meta.videos)) {
                    meta.videos.forEach(function(video) {
                        var epUrl = encodeUrl(addonUrl, type, video.id || id, video.season || 1, video.episode || video.number || 1);
                        episodes.push(new Episode({
                            name: video.title || video.name || "Episode " + (video.episode || video.number || 1),
                            url: epUrl,
                            season: video.season || 1,
                            episode: video.episode || video.number || 1,
                            posterUrl: video.thumbnail || meta.poster || "",
                            description: video.description || "",
                            airDate: video.released || ""
                        }));
                    });
                }

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

                var description = "";
                if (meta.description) {
                    description = meta.description.replace(/<[^>]*>/g, "").trim();
                }

                var multimediaItem = new MultimediaItem({
                    title: meta.name || meta.title || meta.englishName || "Unknown",
                    url: url,
                    posterUrl: meta.poster || "",
                    bannerUrl: meta.background || meta.backdrop || "",
                    logoUrl: meta.logo || "",
                    type: skystreamType,
                    description: description,
                    year: meta.year || meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined,
                    score: meta.score || undefined,
                    genres: meta.genres || meta.tags || undefined,
                    status: meta.status ? (meta.status.toLowerCase().indexOf("releasing") !== -1 || meta.status.toLowerCase().indexOf("ongoing") !== -1 ? "ongoing" : "completed") : undefined,
                    episodes: episodes
                });

                return cb({ success: true, data: multimediaItem });
            }

            // Fallback: create basic item from decoded URL info
            var skystreamType = (type === "series" || type === "tv" || type === "anime" || type === "hentai") ? "series" : "movie";
            cb({
                success: true,
                data: new MultimediaItem({
                    title: "Content (" + id.substring(0, 30) + ")",
                    url: url,
                    type: skystreamType,
                    description: "Browse and play streams from the source addon.",
                    episodes: [new Episode({
                        name: skystreamType === "movie" ? "Full Movie" : "Watch",
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
     * loadStreams: Fetches playable streams from the source addon.
     * 
     * Handles all Stremio stream types:
     * - Direct HTTP(S) URLs (HLS/MP4/DASH) with proper headers
     * - Torrent infoHashes (magnet URLs with trackers from GitHub)
     * - YouTube embeds
     * - External URLs (passthrough)
     * - Stream URLs with embedded infoHash
     * 
     * @param {string} url - Encoded URL from episode
     * @param {Function} cb - Callback
     */
    async function loadStreams(url, cb) {
        try {
            var decoded = decodeUrl(url);
            if (!decoded) {
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

            var addonName = extractSourceName(addonUrl);
            var rawStreams = [];

            // Try multiple stream URL formats for maximum compatibility:
            // Format 1 (standard): /stream/{type}/{id}.json - uses video/episode ID directly
            // Format 2 (fallback): /stream/{type}/{id}:{season}:{episode}.json - colon-separated
            var urlsToTry = [addonUrl + "/stream/" + type + "/" + encodeURIComponent(id) + ".json"];
            if ((type === "series" || type === "anime" || type === "hentai") && season > 0 && episode > 0) {
                urlsToTry.push(addonUrl + "/stream/" + type + "/" + encodeURIComponent(id) + ":" + season + ":" + episode + ".json");
            }

            for (var ui = 0; ui < urlsToTry.length; ui++) {
                var streamData = await fetchJsonSafe(urlsToTry[ui], HEADERS);
                if (streamData && streamData.streams && Array.isArray(streamData.streams) && streamData.streams.length > 0) {
                    rawStreams = streamData.streams;
                    break;
                }
            }

            var streams = [];

            // Process each stream from the addon
            for (var s = 0; s < rawStreams.length; s++) {
                var stream = rawStreams[s];

                    // Combine source name from name, title, description (same as reference)
                    var pName = stream.name ? stream.name.replace(/\n/g, " ") : "";
                    var pTitle = stream.title ? stream.title.replace(/\n/g, " ") : "";
                    var pDesc = stream.description ? stream.description.replace(/\n/g, " ") : "";
                    var sourceName;
                    if (pName && pTitle) sourceName = pName + " - " + pTitle;
                    else if (pName && pDesc) sourceName = pName + " - " + pDesc;
                    else if (pName) sourceName = pName;
                    else if (pTitle) sourceName = pTitle;
                    else if (pDesc) sourceName = pDesc;
                    else sourceName = addonName;

                    var quality = extractQuality(stream.name || stream.title || stream.description || stream.url || "");
                    var title = stream.title || stream.name || "";

                    // --- 1) DIRECT HTTP(S) URL STREAMS (HLS/MP4/DASH) ---
                    if (stream.url && isValidHttpUrl(stream.url)) {
                        var headers = { "Referer": addonUrl + "/", "User-Agent": USER_AGENT };
                        var bh = stream.behaviorHints || {};

                        // Merge headers from behaviorHints (same as reference)
                        if (bh.proxyHeaders && bh.proxyHeaders.request) {
                            headers = Object.assign(headers, bh.proxyHeaders.request);
                        } else if (bh.headers) {
                            headers = Object.assign(headers, bh.headers);
                        }

                        // Add Origin header for HLS/DASH
                        if (stream.url.indexOf(".m3u8") !== -1 || stream.url.indexOf(".mpd") !== -1) {
                            if (!headers["Origin"]) {
                                try {
                                    var parsed = new URL(stream.url);
                                    headers["Origin"] = parsed.protocol + "//" + parsed.hostname;
                                } catch (e) {}
                            }
                        }

                        // Build subtitle objects
                        var subtitles = undefined;
                        if (stream.subtitles && Array.isArray(stream.subtitles) && stream.subtitles.length > 0) {
                            subtitles = stream.subtitles.map(function(sub) {
                                return { url: sub.url, lang: sub.lang || "Unknown" };
                            });
                        }

                        // Build full source label with quality
                        var fullSource = addonName;
                        if (quality !== "Auto") fullSource += " " + quality;
                        if (title) fullSource += " - " + title;

                        streams.push(new StreamResult({
                            url: stream.url,
                            quality: quality,
                            source: fullSource,
                            title: title,
                            headers: headers,
                            subtitles: subtitles,
                            behaviorHints: bh,
                            cached: stream.cached || false,
                            size: stream.size || null
                        }));
                        continue;
                    }

                    // --- 2) TORRENT STREAMS (infoHash) ---
                    // Build magnet URL with trackers (same approach as reference)
                    if (stream.infoHash) {
                        var infoHash = stream.infoHash;
                        var fileIdx = stream.fileIdx !== undefined ? stream.fileIdx : 0;

                        // Build magnet URL
                        var magnetUrl = "magnet:?xt=urn:btih:" + infoHash;

                        // Add source trackers (with "tracker:" prefix handling, same as reference)
                        if (stream.sources && Array.isArray(stream.sources)) {
                            for (var t = 0; t < stream.sources.length; t++) {
                                var src = stream.sources[t];
                                // Handle "tracker:udp://..." format (Stremio convention)
                                if (src.indexOf("tracker:") === 0) {
                                    var trackerUrl = src.substring("tracker:".length);
                                    if (trackerUrl.length > 0) {
                                        magnetUrl += "&tr=" + encodeURIComponent(trackerUrl);
                                    }
                                } else {
                                    magnetUrl += "&tr=" + encodeURIComponent(src);
                                }
                            }
                        }

                        // Add trackers from GitHub master tracker list (same as reference)
                        var trackers = await getTrackers();
                        for (var t2 = 0; t2 < trackers.length; t2++) {
                            magnetUrl += "&tr=" + encodeURIComponent(trackers[t2]);
                        }

                        // Full source label
                        var torrentSource = addonName;
                        if (quality !== "Auto") torrentSource += " " + quality;
                        if (title) torrentSource += " - " + title;

                        var torrentProps = {
                            quality: quality,
                            source: torrentSource,
                            title: title,
                            headers: { "User-Agent": USER_AGENT, "Referer": addonUrl + "/" },
                            infoHash: infoHash,
                            fileIndex: fileIdx,
                            cached: stream.cached || false,
                            size: stream.size || null,
                            behaviorHints: stream.behaviorHints || { notWebReady: true }
                        };

                        // Magnet URL (primary format)
                        streams.push(new StreamResult(Object.assign({}, torrentProps, {
                            url: magnetUrl
                        })));
                        continue;
                    }

                    // --- 3) YOUTUBE EMBEDS ---
                    if (stream.ytId) {
                        streams.push(new StreamResult({
                            url: "https://www.youtube.com/watch?v=" + stream.ytId,
                            quality: "YouTube",
                            source: "YouTube",
                            headers: { "Referer": "https://www.youtube.com/", "User-Agent": USER_AGENT },
                            behaviorHints: { notWebReady: true }
                        }));
                        continue;
                    }

                    // --- 4) EXTERNAL URL (Stremio protocol: stream.externalUrl) ---
                    // Some addons return externalUrl for streams hosted on external sites
                    if (stream.externalUrl) {
                        streams.push(new StreamResult({
                            url: stream.externalUrl,
                            quality: quality,
                            source: addonName + " External",
                            title: title,
                            headers: { "User-Agent": USER_AGENT, "Referer": addonUrl + "/" },
                            behaviorHints: stream.behaviorHints || { notWebReady: true }
                        }));
                        continue;
                    }

                    // --- 5) FALLBACK: Any other URL format (magnet, etc.) ---
                    if (stream.url) {
                        var fallbackUrl = stream.url;
                        var fallbackInfoHash = null;

                        // Try to extract infoHash from magnet URLs
                        if (fallbackUrl.indexOf("magnet:?xt=urn:btih:") === 0) {
                            var match = fallbackUrl.match(/urn:btih:([a-fA-F0-9]+)/);
                            if (match) {
                                fallbackInfoHash = match[1].toLowerCase();
                            }
                        }

                        var fallbackProps = {
                            url: fallbackUrl,
                            quality: quality,
                            source: addonName + " " + (stream.name || ""),
                            title: title,
                            headers: { "User-Agent": USER_AGENT, "Referer": addonUrl + "/" },
                            behaviorHints: stream.behaviorHints || undefined
                        };

                        if (fallbackInfoHash) {
                            fallbackProps.infoHash = fallbackInfoHash;
                            fallbackProps.fileIndex = 0;
                        }

                        streams.push(new StreamResult(fallbackProps));
                    }
                }

            // Deduplicate streams by URL (keep first occurrence)
            var seen = {};
            streams = streams.filter(function(s) {
                var key = s.url;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            // Sort by quality (highest first)
            streams.sort(function(a, b) {
                var qMap = { "4K": 0, "2160p": 0, "1440p": 1, "1080p": 2, "720p": 3, "480p": 4, "360p": 5, "Auto": 6, "YouTube": 7 };
                var aQ = qMap[a.quality] || 6;
                var bQ = qMap[b.quality] || 6;
                return aQ - bQ;
            });

            cb({ success: true, data: streams });
        } catch (e) {
            console.error("loadStreams error:", e.message);
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message });
        }
    }

    // === Helper Functions ===

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

    function extractSourceName(addonUrl) {
        try {
            var hostname = new URL(addonUrl).hostname;
            return hostname.replace(/^www\./, "").split(".")[0];
        } catch (e) {
            return "Addon";
        }
    }

    function isValidHttpUrl(str) {
        if (!str) return false;
        return str.indexOf("http://") === 0 || str.indexOf("https://") === 0;
    }

    // === Export Functions ===
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();

(function() {
    /**
     * StremioHub v2 - Streaming Catalogs + Multi-Source Stream Aggregator
     * 
     * Architecture:
     *   - Catalog: Netflix streaming catalogs addon (browse by service)
     *   - Metadata: Cinemeta (IMDb IDs, episodes for series)
     *   - Streams: Query ALL configured stream addons for each content
     * 
     * User clicks a movie/episode -> query all configured addons for streams
     */

    var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    var HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.5"
    };
    var CINEMETA_URL = "https://v3-cinemeta.strem.io";

    // === Cache ===
    var catalogManifestCache = null;
    var lastManifestFetch = 0;
    var MANIFEST_CACHE_TTL = 300000;

    // === URL Encoding ===
    // URL = JSON.stringify({ i: imdbId, t: type, s: season, e: episode })
    function encodeUrl(imdbId, type, season, episode) {
        return JSON.stringify({
            i: imdbId,
            t: type,
            s: season || 0,
            e: episode || 0
        });
    }

    function decodeUrl(url) {
        try { return JSON.parse(url); } catch (e) { return null; }
    }

    function getBaseUrl(manifestUrl) {
        return manifestUrl.replace(/\/manifest\.json$/, "").replace(/\/$/, "");
    }

    // === HTTP Helpers ===
    async function fetchJson(url, headers) {
        var merged = Object.assign({}, HEADERS, headers || {});
        var res = await http_get(url, merged);
        if (!res || !res.body) throw new Error("Empty response");
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

    async function fetchWithTimeout(url, headers, timeoutMs) {
        timeoutMs = timeoutMs || 10000;
        return new Promise(function(resolve) {
            var timedOut = false;
            var timer = setTimeout(function() { timedOut = true; resolve(null); }, timeoutMs);
            fetchJsonSafe(url, headers).then(function(result) {
                if (!timedOut) { clearTimeout(timer); resolve(result); }
            }).catch(function() {
                if (!timedOut) { clearTimeout(timer); resolve(null); }
            });
        });
    }

    // === Addon Config ===
    function getCatalogAddonUrl() {
        return manifest && manifest.catalogAddon ? manifest.catalogAddon : null;
    }

    function getStreamAddonUrls() {
        return manifest && manifest.streamAddons ? manifest.streamAddons : [];
    }

    async function getCatalogManifest() {
        var now = Date.now();
        if (catalogManifestCache && (now - lastManifestFetch) < MANIFEST_CACHE_TTL) {
            return catalogManifestCache;
        }
        var url = getCatalogAddonUrl();
        if (!url) return null;
        var data = await fetchJsonSafe(url, HEADERS);
        if (data) {
            catalogManifestCache = data;
            lastManifestFetch = now;
        }
        return data;
    }

    // === Quality Extraction ===
    function extractQuality(str) {
        if (!str) return "Auto";
        var s = String(str).toLowerCase();
        // Match quality patterns with optional trailing 'p' or 'i'
        if (/\b(2160p?|4k|uhd)\b/.test(s)) return "4K";
        if (/\b1440p?\b/.test(s)) return "1440p";
        if (/\b1080p?\b/.test(s)) return "1080p";
        if (/\b720p?\b/.test(s)) return "720p";
        if (/\b480p?\b/.test(s)) return "480p";
        if (/\b360p?\b/.test(s)) return "360p";
        if (/\bsd\b/.test(s)) return "480p";
        if (/\bhq\b/.test(s)) return "720p";
        if (/\bhd\b/.test(s) && !/\bhd[\s-]?tv\b/.test(s)) return "720p";
        // Check resolution patterns like 1920x1080
        var resMatch = s.match(/(\d{3,4})\s*x\s*(\d{3,4})/);
        if (resMatch) {
            var height = parseInt(resMatch[2]);
            if (height >= 2100) return "4K";
            if (height >= 1400) return "1440p";
            if (height >= 1000) return "1080p";
            if (height >= 700) return "720p";
            if (height >= 400) return "480p";
        }
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

    // === Tracker Management ===
    var TRACKER_LIST_URL = "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt";
    var trackersCache = null;
    var lastTrackersFetch = 0;
    var TRACKER_CACHE_TTL = 600000;

    async function getTrackers() {
        var now = Date.now();
        if (trackersCache && (now - lastTrackersFetch) < TRACKER_CACHE_TTL) return trackersCache;
        try {
            var merged = Object.assign({}, HEADERS);
            var res = await http_get(TRACKER_LIST_URL, merged);
            if (res && res.body) {
                var lines = res.body.split("\n");
                var trackers = [];
                for (var i = 0; i < lines.length; i++) {
                    if (i % 2 === 0) {
                        var line = lines[i].trim();
                        if (line.length > 0) trackers.push(line);
                    }
                }
                trackersCache = trackers;
                lastTrackersFetch = now;
                return trackers;
            }
        } catch (e) {}
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

    // === Catalog Item Conversion ===
    function catalogItemToMediaItem(item) {
        if (!item) return null;
        var type = item.type || "movie";
        var imdbId = item.imdb_id || item.id || "";
        var skystreamType = (type === "series" || type === "tv" || type === "anime") ? "series" : "movie";

        return new MultimediaItem({
            title: item.name || item.title || "Unknown",
            url: encodeUrl(imdbId, type),
            posterUrl: item.poster || "",
            bannerUrl: item.background || item.backdrop || "",
            type: skystreamType,
            description: (item.description || "").replace(/<[^>]*>/g, "").trim().substring(0, 500),
            year: item.year ? parseInt(item.year) : (item.releaseInfo ? parseInt(item.releaseInfo) : undefined),
            score: item.imdbRating ? parseFloat(item.imdbRating) : (item.score || undefined),
            genres: item.genre || item.genres || undefined
        });
    }

    // === Stream Processing ===
    async function processStreamResponse(streams, addonName, baseUrl) {
        if (!streams || !Array.isArray(streams)) return [];
        var trackers = await getTrackers();
        var results = [];

        for (var s = 0; s < streams.length; s++) {
            var stream = streams[s];
            var pName = stream.name ? stream.name.replace(/\n/g, " ") : "";
            var pTitle = stream.title ? stream.title.replace(/\n/g, " ") : "";
            
            var quality = extractQuality((stream.name || "") + " " + (stream.title || "") + " " + (stream.description || "") + " " + (stream.url || ""));
            var title = stream.title || stream.name || "";

            var sourceName = addonName;
            if (pName) sourceName = pName;
            if (pTitle && pName !== pTitle) sourceName += " - " + pTitle;

            // --- 1) DIRECT HTTP(S) URL ---
            if (stream.url && isValidHttpUrl(stream.url)) {
                var headers = { "Referer": baseUrl + "/", "User-Agent": USER_AGENT };
                var bh = stream.behaviorHints || {};
                if (bh.proxyHeaders && bh.proxyHeaders.request) headers = Object.assign(headers, bh.proxyHeaders.request);
                else if (bh.headers) headers = Object.assign(headers, bh.headers);

                if (stream.url.indexOf(".m3u8") !== -1 || stream.url.indexOf(".mpd") !== -1) {
                    if (!headers["Origin"]) {
                        try { headers["Origin"] = new URL(stream.url).protocol + "//" + new URL(stream.url).hostname; } catch (e) {}
                    }
                }

                var subtitles = undefined;
                if (stream.subtitles && Array.isArray(stream.subtitles) && stream.subtitles.length > 0) {
                    subtitles = stream.subtitles.map(function(sub) { return { url: sub.url, lang: sub.lang || "Unknown" }; });
                }

                results.push(new StreamResult({
                    url: stream.url, quality: quality, source: sourceName, title: title,
                    headers: headers, subtitles: subtitles, behaviorHints: bh,
                    cached: stream.cached || false, size: stream.size || null
                }));
                continue;
            }

            // --- 2) TORRENT (infoHash) ---
            if (stream.infoHash) {
                var infoHash = stream.infoHash;
                var fileIdx = stream.fileIdx !== undefined ? stream.fileIdx : 0;
                var magnetUrl = "magnet:?xt=urn:btih:" + infoHash;
                
                // Source trackers
                if (stream.sources && Array.isArray(stream.sources)) {
                    for (var t = 0; t < stream.sources.length; t++) {
                        var src = stream.sources[t];
                        if (src.indexOf("tracker:") === 0) {
                            var tu = src.substring("tracker:".length);
                            if (tu.length > 0) magnetUrl += "&tr=" + encodeURIComponent(tu);
                        } else {
                            magnetUrl += "&tr=" + encodeURIComponent(src);
                        }
                    }
                }
                // GitHub trackers
                for (var t2 = 0; t2 < trackers.length; t2++) {
                    magnetUrl += "&tr=" + encodeURIComponent(trackers[t2]);
                }

                var torrentSource = sourceName;
                if (quality !== "Auto") torrentSource += " " + quality;
                if (title) torrentSource += " - " + title;

                results.push(new StreamResult({
                    url: magnetUrl, quality: quality, source: torrentSource, title: title,
                    headers: { "User-Agent": USER_AGENT, "Referer": baseUrl + "/" },
                    infoHash: infoHash, fileIndex: fileIdx,
                    cached: stream.cached || false, size: stream.size || null,
                    behaviorHints: stream.behaviorHints || { notWebReady: true }
                }));
                continue;
            }

            // --- 3) YOUTUBE ---
            if (stream.ytId) {
                results.push(new StreamResult({
                    url: "https://www.youtube.com/watch?v=" + stream.ytId,
                    quality: "YouTube", source: "YouTube",
                    headers: { "Referer": "https://www.youtube.com/", "User-Agent": USER_AGENT },
                    behaviorHints: { notWebReady: true }
                }));
                continue;
            }

            // --- 4) EXTERNAL URL ---
            if (stream.externalUrl) {
                results.push(new StreamResult({
                    url: stream.externalUrl, quality: quality,
                    source: addonName + " External", title: title,
                    headers: { "User-Agent": USER_AGENT, "Referer": baseUrl + "/" },
                    behaviorHints: stream.behaviorHints || { notWebReady: true }
                }));
                continue;
            }

            // --- 5) FALLBACK ---
            if (stream.url) {
                var fbUrl = stream.url;
                var fbHash = null;
                if (fbUrl.indexOf("magnet:?xt=urn:btih:") === 0) {
                    var match = fbUrl.match(/urn:btih:([a-fA-F0-9]+)/);
                    if (match) fbHash = match[1].toLowerCase();
                }
                var fbProps = {
                    url: fbUrl, quality: quality,
                    source: addonName + " " + (stream.name || ""), title: title,
                    headers: { "User-Agent": USER_AGENT, "Referer": baseUrl + "/" },
                    behaviorHints: stream.behaviorHints || undefined
                };
                if (fbHash) { fbProps.infoHash = fbHash; fbProps.fileIndex = 0; }
                results.push(new StreamResult(fbProps));
            }
        }
        return results;
    }

    // === getHome ===
    async function getHome(cb, page) {
        try {
            var pageNum = parseInt(page) || 1;
            var manifestData = await getCatalogManifest();
            if (!manifestData) {
                return cb({ success: false, errorCode: "NO_CATALOG", message: "No catalog addon configured" });
            }

            var catalogs = manifestData.catalogs || [];
            var baseUrl = getBaseUrl(getCatalogAddonUrl());
            var homeSections = {};
            var sectionOrder = [];

            if (pageNum === 1) {
                var promises = catalogs.map(function(cat) {
                    return (async function() {
                        try {
                            var url = baseUrl + "/catalog/" + cat.type + "/" + cat.id + ".json";
                            var data = await fetchJsonSafe(url, HEADERS);
                            if (!data || !data.metas || data.metas.length === 0) return null;

                            var items = data.metas.map(function(m) { return catalogItemToMediaItem(m); })
                                .filter(function(item) { return item !== null; });
                            if (items.length === 0) return null;

                            var sectionName = cat.name;
                            if (cat.type === "movie") sectionName += " Movies";
                            else if (cat.type === "series") sectionName += " Series";
                            else sectionName += " " + cat.type;
                            return { name: sectionName, items: items };
                        } catch (e) { return null; }
                    })();
                });

                var results = await Promise.allSettled(promises);
                results.forEach(function(result) {
                    if (result.status === "fulfilled" && result.value) {
                        homeSections[result.value.name] = result.value.items;
                        sectionOrder.push(result.value.name);
                    }
                });
            }

            if (Object.keys(homeSections).length === 0) {
                return cb({ success: false, errorCode: "NO_DATA", message: "No catalog data available" });
            }

            var orderedData = {};
            sectionOrder.forEach(function(n) { if (homeSections[n]) orderedData[n] = homeSections[n]; });
            cb({ success: true, data: orderedData, page: pageNum });
        } catch (e) {
            console.error("getHome error:", e.message);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    // === search ===
    async function search(query, cb) {
        try {
            var q = String(query || "").trim();
            if (!q) return cb({ success: true, data: [] });

            // Search via Cinemeta
            var movieUrl = CINEMETA_URL + "/catalog/movie/top/search=" + encodeURIComponent(q) + ".json";
            var seriesUrl = CINEMETA_URL + "/catalog/series/top/search=" + encodeURIComponent(q) + ".json";

            var results = [];
            var [movieData, seriesData] = await Promise.all([
                fetchJsonSafe(movieUrl, HEADERS),
                fetchJsonSafe(seriesUrl, HEADERS)
            ]);

            if (movieData && movieData.metas) {
                movieData.metas.forEach(function(m) {
                    var item = catalogItemToMediaItem(m);
                    if (item) results.push(item);
                });
            }
            if (seriesData && seriesData.metas) {
                seriesData.metas.forEach(function(m) {
                    var item = catalogItemToMediaItem(m);
                    if (item) results.push(item);
                });
            }

            // Deduplicate by title
            var seen = {};
            results = results.filter(function(item) {
                var key = item.title.toLowerCase();
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            cb({ success: true, data: results });
        } catch (e) {
            console.error("search error:", e.message);
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message });
        }
    }

    // === load ===
    async function load(url, cb) {
        try {
            var decoded = decodeUrl(url);
            if (!decoded) {
                return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid URL format" });
            }

            var imdbId = decoded.i;
            var type = decoded.t;

            var metaUrl = CINEMETA_URL + "/meta/" + type + "/" + encodeURIComponent(imdbId) + ".json";
            var data = await fetchJsonSafe(metaUrl, HEADERS);

            if (data && data.meta) {
                var meta = data.meta;
                var skystreamType = (type === "series" || type === "tv" || type === "anime") ? "series" : "movie";

                var episodes = [];
                if (meta.videos && Array.isArray(meta.videos)) {
                    meta.videos.forEach(function(video) {
                        var epUrl = encodeUrl(imdbId, type, video.season || 1, video.episode || video.number || 1);
                        episodes.push(new Episode({
                            name: video.title || video.name || "Episode " + (video.episode || video.number || 1),
                            url: epUrl, season: video.season || 1, episode: video.episode || video.number || 1,
                            posterUrl: video.thumbnail || meta.poster || "",
                            description: video.description || "", airDate: video.released || ""
                        }));
                    });
                }

                if (episodes.length === 0) {
                    episodes.push(new Episode({
                        name: skystreamType === "movie" ? "Full Movie" : "Watch",
                        url: url, season: 1, episode: 1,
                        posterUrl: meta.poster || "",
                        description: (meta.description || "").replace(/<[^>]*>/g, "").trim()
                    }));
                }

                return cb({ success: true, data: new MultimediaItem({
                    title: meta.name || meta.title || "Unknown", url: url,
                    posterUrl: meta.poster || "", bannerUrl: meta.background || meta.backdrop || "",
                    logoUrl: meta.logo || "", type: skystreamType,
                    description: (meta.description || "").replace(/<[^>]*>/g, "").trim(),
                    year: meta.year ? parseInt(meta.year) : (meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined),
                    score: meta.score || (meta.imdbRating ? parseFloat(meta.imdbRating) : undefined),
                    genres: meta.genres || meta.tags || undefined,
                    episodes: episodes
                })});
            }

            // Fallback
            var fbType = (type === "series" || type === "tv" || type === "anime") ? "series" : "movie";
            cb({ success: true, data: new MultimediaItem({
                title: "Content (" + imdbId.substring(0, 30) + ")", url: url, type: fbType,
                description: "Browse and play streams from source addons.",
                episodes: [new Episode({ name: fbType === "movie" ? "Full Movie" : "Watch", url: url, season: 1, episode: 1 })]
            })});
        } catch (e) {
            console.error("load error:", e.message);
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    // === loadStreams ===
    async function loadStreams(url, cb) {
        try {
            var decoded = decodeUrl(url);
            if (!decoded) {
                return cb({ success: true, data: [new StreamResult({
                    url: url, quality: "Auto", source: "Direct", headers: HEADERS
                })] });
            }

            var imdbId = decoded.i;
            var type = decoded.t;
            var season = decoded.s;
            var episode = decoded.e;

            var addonUrls = getStreamAddonUrls();
            if (addonUrls.length === 0) {
                return cb({ success: true, data: [] });
            }

            // Query all stream addons concurrently
            var streamTasks = addonUrls.map(function(addonManifestUrl) {
                return (async function() {
                    try {
                        var baseUrl = getBaseUrl(addonManifestUrl);
                        var addonName = extractSourceName(addonManifestUrl);
                        var encodedImdb = encodeURIComponent(imdbId);

                        // Try multiple URL formats
                        var urlsToTry = [baseUrl + "/stream/" + type + "/" + encodedImdb + ".json"];
                        if (season > 0 && episode > 0) {
                            urlsToTry.push(baseUrl + "/stream/" + type + "/" + encodedImdb + ":" + season + ":" + episode + ".json");
                        }

                        for (var ui = 0; ui < urlsToTry.length; ui++) {
                            var streamData = await fetchWithTimeout(urlsToTry[ui], HEADERS, 10000);
                            if (streamData && streamData.streams && streamData.streams.length > 0) {
                                return await processStreamResponse(streamData.streams, addonName, baseUrl);
                            }
                        }
                        return [];
                    } catch (e) { return []; }
                })();
            });

            var streamResults = await Promise.allSettled(streamTasks);
            var allStreams = [];
            streamResults.forEach(function(result) {
                if (result.status === "fulfilled" && result.value) {
                    allStreams = allStreams.concat(result.value);
                }
            });

            // Deduplicate by URL or infoHash
            var seen = {};
            allStreams = allStreams.filter(function(s) {
                var key = s.infoHash || s.url;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            // Sort by quality
            allStreams.sort(function(a, b) {
                var qMap = { "4K": 0, "2160p": 0, "1440p": 1, "1080p": 2, "720p": 3, "480p": 4, "360p": 5, "Auto": 6, "YouTube": 7 };
                return (qMap[a.quality] || 6) - (qMap[b.quality] || 6);
            });

            cb({ success: true, data: allStreams });
        } catch (e) {
            console.error("loadStreams error:", e.message);
            cb({ success: false, errorCode: "STREAM_ERROR", message: e.message });
        }
    }

    // === Exports ===
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();

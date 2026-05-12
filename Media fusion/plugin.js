(function() {
    /**
     * StremioNsfw v3 - Refined NSFW Addon Aggregator
     * 
     * Features:
     *  - Catalogs from ALL configured addons shown as dashboard sections
     *  - Search across EVERY catalog (not just ones declaring search)
     *  - TMDB fallback search when addons return nothing
     *  - Multi-format stream support with rich quality parsing
     *  - Proper Referer/Origin headers for all streams
     *  - Trackers from GitHub master list for torrents
     *  - Concurrent addon queries with strict timeouts
     *  - Stream result caching + stale cache fallback
     *  - Subtitle language normalization
     */

    "use strict";

    // ============================================================
    //  CONFIGURATION
    // ============================================================
    var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    var HEADERS = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.5"
    };
    var ADDON_TIMEOUT_MS = 10000;
    var ITEMS_PER_CATALOG = 20;

    var TRACKER_URLS = [
        "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
        "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt"
    ];
    var TRACKER_CACHE_TTL = 600000;

    var MANIFEST_CACHE_TTL = 300000;
    var MANIFEST_STALE_TTL = 1800000;
    var STREAM_CACHE_TTL = 300000;

    var ADDON_URLS = [
        "https://mediafusion.elfhosted.com/D-BgvYOjurcma6kjaY8UpEobMgYa3gvWCvHQpyVSUE3nHfq9ZT0wGYQ2cck2JuyVsSCKRVS7wgxJSGZ3NIgxks7jAuEiCKhUTUaM0MFqKM3Cv26DxtLLNpJrJ6gjoI6azKDVjX31VI4T4b_LldN241zABbOxmN1Ud-_ziVQ71KpOhDp0z219rLsUpewWAIp-mSykOorqxD-148f19aaY_zhelEOQ0oxNQnzMwOMSiAITd0DKhSTLv6h4AqcrC_Lai7vF7oku3jSTXpeBL3u7axC_BLRlpVuINot4OgebJYWj_AKPp42SKx-NB_SzUa_y6qiNYWWjKXQY0r3hdAJ5L5Fo2b0jUXnzYhfDFAVpP5IJFs5ttdP-aVcMa9BxLuRnWpo80XkxfOXFAZq18BCx5tQtPgSsQ-VCHKOhU4hn2TwJZ3p5SUkcqbij2FNZWeiXJmGKSgxXgt1lmHfmd6c4wBlqzWVnBZI4y-NgutgI8R_EnZehH3xvQE1j5h79ZnxaDwmFvcqv3qS2Uk0jCylkOJZ5oedmLoTqsrnROMmHXzQWwkTLjQXU5dcFRuAJYVmjJVjiG5UGXzA5jRJL85Xq_dgiL08yz9zFDGyazbButFaUX41_uGJEFFEhFLznzcln9mv4Tj9R7d9_ES9MqYlKuQxFGrEUR8HgBvicAZ5FfxhTkAS4lx7QraShSUfxQYzToyjz1oFdXpkBoZU_hMqeS2-TlHlDeTUtfZoMIkqnDjGiVlDSBG_fO7lHAWvkc-Cwq627cBE0gM_UlZjYUO1KaLXlsh-fo08siiPUChxVvQ631yPusMSAblTjQq7Gw60o2RdD8aQsL-yeCCd3yrWkQuuu0Y_BLWYmhYi-jpjnLQqu-RGrCFScI-blDvrzL-1qjmtzohWZtQB-9DfftWZc8Xlv63Zw7BZTfchXaDyWzl91qKgu19T74EuCdOR4wah3nfO9gwdpZqaqx0kregUwsnHhfRsClZRLRh2HofxQ1gzjixHVC557FlKHKAEMJCmuXQVrsc2-phlH_ayuS3VOfuT0FlNoxntyWCty8BFuWPaCZUzoahKy_GU-XCveWKbz9ZXYo_KbnQjYnazsLerD8l_WAVni0fQYnHiFw8C2mX_gW1F5z1MALq24yANvXGu79I2EOZ8qK-QevLcgwdHbicajTuGJ3X88O4Kyxvf3Za_ZhVuHciS7bHHR4LOhDCwkLoip-P_mvKunw4Oo998C_EAX31EGTCS4yFyuHlq8r9M-bPSGBOK7bXbOzodM3e_n1Fx1DBhkKRoDtMf6FcJHPzaS84cMBQMzG1hewktgnE6MtfHMts3C770OeMoaGt_am8dh-7euJf9faGH2XyINksig/manifest.json"
    ];

    // ============================================================
    //  CACHES
    // ============================================================
    var addonManifestsCache = null;
    var lastManifestSuccess = 0;
    var trackersCache = null;
    var lastTrackersFetch = 0;
    var streamResultCache = {};

    // ============================================================
    //  LANGUAGE MAP
    // ============================================================
    var LANG_MAP = {
        "en": "English", "es": "Spanish", "fr": "French", "de": "German",
        "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese",
        "ko": "Korean", "zh": "Chinese", "ar": "Arabic", "hi": "Hindi",
        "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "th": "Thai",
        "vi": "Vietnamese", "cs": "Czech", "hu": "Hungarian", "ro": "Romanian",
        "he": "Hebrew", "el": "Greek", "sv": "Swedish", "da": "Danish",
        "no": "Norwegian", "fi": "Finnish", "id": "Indonesian", "ms": "Malay",
        "bg": "Bulgarian", "uk": "Ukrainian", "sr": "Serbian", "hr": "Croatian",
        "sk": "Slovak", "lt": "Lithuanian", "lv": "Latvian", "et": "Estonian",
        "is": "Icelandic", "mt": "Maltese", "sl": "Slovenian", "km": "Khmer",
        "lo": "Lao", "bn": "Bengali", "ta": "Tamil", "te": "Telugu",
        "mr": "Marathi",
        "eng": "English", "spa": "Spanish", "fra": "French", "fre": "French",
        "deu": "German", "ger": "German", "ita": "Italian", "por": "Portuguese",
        "rus": "Russian", "jpn": "Japanese", "kor": "Korean", "zho": "Chinese",
        "chi": "Chinese", "ara": "Arabic", "hin": "Hindi", "nld": "Dutch",
        "dut": "Dutch", "pol": "Polish", "tur": "Turkish", "tha": "Thai",
        "vie": "Vietnamese", "ces": "Czech", "cze": "Czech", "hun": "Hungarian",
        "ron": "Romanian", "rum": "Romanian", "heb": "Hebrew", "ell": "Greek",
        "gre": "Greek", "swe": "Swedish", "dan": "Danish", "nor": "Norwegian",
        "fin": "Finnish", "ind": "Indonesian", "msa": "Malay", "may": "Malay",
        "bul": "Bulgarian", "ukr": "Ukrainian", "srp": "Serbian", "hrv": "Croatian",
        "slk": "Slovak", "slo": "Slovak", "lit": "Lithuanian", "lva": "Latvian",
        "est": "Estonian", "isl": "Icelandic", "mlt": "Maltese", "slv": "Slovenian",
        "khm": "Khmer", "lao": "Lao", "ben": "Bengali", "tam": "Tamil",
        "tel": "Telugu", "mar": "Marathi"
    };

    // ============================================================
    //  LOGGING
    // ============================================================
    var DEBUG = true;
    function log(level, msg, data) {
        if (level === "debug" && !DEBUG) return;
        var pfx = "[" + level.toUpperCase() + "][StremioNsfw] ";
        if (data !== undefined) console.log(pfx + msg, data);
        else console.log(pfx + msg);
    }

    // ============================================================
    //  URL HELPERS
    // ============================================================
    function encodeUrl(addonUrl, type, id, season, episode, poster, title) {
        var obj = { a: addonUrl, t: type, i: id, s: season || 0, e: episode || 0 };
        if (poster) obj.p = poster;
        if (title) obj.n = title;
        return JSON.stringify(obj);
    }

    function decodeUrl(url) {
        try { return JSON.parse(url); } catch (e) { return null; }
    }

    function getBaseUrl(manifestUrl) {
        return manifestUrl.replace(/\/manifest\.json$/, "").replace(/\/$/, "");
    }

    function isValidHttpUrl(str) {
        if (!str) return false;
        return str.indexOf("http://") === 0 || str.indexOf("https://") === 0;
    }

    // ============================================================
    //  HTTP HELPERS (race-condition-free)
    // ============================================================
    async function fetchJson(url, headers) {
        var merged = Object.assign({}, HEADERS, headers || {});
        var res = await http_get(url, merged);
        if (!res || !res.body) throw new Error("Empty response");
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        var body = res.body;
        if (typeof body === "string" && body.trim().charAt(0) === "<") throw new Error("HTML response (blocked)");
        if (typeof body === "object") return body;
        return JSON.parse(body);
    }

    async function fetchJsonSafe(url, headers) {
        try { return await fetchJson(url, headers); } catch (e) { return null; }
    }

    function fetchWithTimeout(url, headers, timeoutMs) {
        timeoutMs = timeoutMs || ADDON_TIMEOUT_MS;
        return new Promise(function(resolve) {
            var resolved = false;
            var timer = setTimeout(function() {
                if (!resolved) { resolved = true; resolve(null); }
            }, timeoutMs);
            fetchJsonSafe(url, headers).then(function(result) {
                if (!resolved) { resolved = true; clearTimeout(timer); resolve(result); }
            }).catch(function() {
                if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
            });
        });
    }

    // ============================================================
    //  ADDON MANAGEMENT
    // ============================================================
    function getAddonUrls() {
        if (ADDON_URLS && ADDON_URLS.length > 0) return ADDON_URLS;
        var urls = [];
        if (manifest && manifest.addons && Array.isArray(manifest.addons)) {
            manifest.addons.forEach(function(url) {
                if (url && typeof url === "string" && url.trim().length > 0) urls.push(url.trim());
            });
        }
        return urls;
    }

    /**
     * Fetch all addon manifests to get their catalogs.
     * Uses stale-while-revalidate caching.
     */
    async function getAddonConfigs() {
        var now = Date.now();
        if (addonManifestsCache && (now - lastManifestSuccess) < MANIFEST_CACHE_TTL) {
            return addonManifestsCache;
        }

        var urls = getAddonUrls();
        var configs = [];

        var results = await Promise.allSettled(urls.map(function(url) {
            return fetchWithTimeout(url, HEADERS, 12000).then(function(manifestData) {
                if (!manifestData) return null;
                var baseUrl = getBaseUrl(url);
                var name = manifestData.name || extractSourceName(url);
                var catalogs = manifestData.catalogs || [];

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
            if (result.status === "fulfilled" && result.value) configs.push(result.value);
        });

        if (configs.length > 0) {
            addonManifestsCache = configs;
            lastManifestSuccess = now;
            return configs;
        }
        // Stale cache fallback
        if (addonManifestsCache && (now - lastManifestSuccess) < MANIFEST_STALE_TTL) {
            log("warn", "Using stale manifest cache");
            return addonManifestsCache;
        }
        return configs;
    }

    async function fetchCatalog(addonConfig, catalogEntry, limit, skip) {
        var url = addonConfig.baseUrl + "/catalog/" + catalogEntry.type + "/" + catalogEntry.id + ".json";
        var params = [];
        if (limit) params.push("limit=" + limit);
        if (skip) params.push("skip=" + skip);
        if (params.length > 0) url += "?" + params.join("&");
        var data = await fetchWithTimeout(url, HEADERS, ADDON_TIMEOUT_MS);
        if (!data || !data.metas) return [];
        return data.metas;
    }

    // ============================================================
    //  TRACKER MANAGEMENT
    // ============================================================
    async function getTrackers() {
        var now = Date.now();
        if (trackersCache && (now - lastTrackersFetch) < TRACKER_CACHE_TTL) return trackersCache;

        var trackerSet = {};
        for (var ti = 0; ti < TRACKER_URLS.length; ti++) {
            try {
                var res = await http_get(TRACKER_URLS[ti], HEADERS);
                if (res && res.body) {
                    var lines = res.body.split("\n");
                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (line && line.indexOf("://") > 0 && line.indexOf("/announce") > 0) {
                            trackerSet[line] = true;
                        }
                    }
                }
            } catch (e) { log("debug", "Failed to fetch trackers from " + TRACKER_URLS[ti], e.message); }
        }

        var fallbacks = [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://tracker.openbittorrent.com:6969/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://exodus.desync.com:6969/announce",
            "udp://public.popcorn-tracker.org:6969/announce"
        ];
        for (var fi = 0; fi < fallbacks.length; fi++) {
            if (!trackerSet[fallbacks[fi]]) trackerSet[fallbacks[fi]] = true;
        }

        trackersCache = Object.keys(trackerSet);
        lastTrackersFetch = now;
        return trackersCache;
    }

    // ============================================================
    //  QUALITY PARSING (v4 standard)
    // ============================================================
    function parseStreamFeatures(str) {
        var result = { resolution: "Auto", codec: null, hdr: null, audio: null,
            channels: null, is3D: false, isRemux: false, isWebdl: false,
            isBluray: false, debrid: null };
        if (!str) return result;
        var s = String(str).toLowerCase();
        if (/\b(2160|4k|uhd)\b/.test(s)) result.resolution = "4K";
        else if (/\b1440\b/.test(s)) result.resolution = "1440p";
        else if (/\b1080\b/.test(s)) result.resolution = "1080p";
        else if (/\b720\b/.test(s)) result.resolution = "720p";
        else if (/\b480\b/.test(s)) result.resolution = "480p";
        else if (/\b360\b/.test(s)) result.resolution = "360p";
        var resMatch = s.match(/(\d{3,4})\s*x\s*(\d{3,4})/);
        if (resMatch) {
            var height = parseInt(resMatch[2]);
            if (height >= 2100) result.resolution = "4K";
            else if (height >= 1400) result.resolution = "1440p";
            else if (height >= 1000) result.resolution = "1080p";
            else if (height >= 700) result.resolution = "720p";
            else if (height >= 400) result.resolution = "480p";
        }
        if (/\b(av1|av01)\b/.test(s)) result.codec = "AV1";
        else if (/\b(x?v?265|hevc)\b/.test(s)) result.codec = "HEVC";
        else if (/\b(x264|h\.?264|avc)\b/.test(s)) result.codec = "H.264";
        if (/\b(dv|dovi|dolby[\s._-]?vision)\b/.test(s)) result.hdr = "DV";
        else if (/\bhdr10\+\b/.test(s)) result.hdr = "HDR10+";
        else if (/\bhdr10\b/.test(s)) result.hdr = "HDR10";
        else if (/\bhdr\b/.test(s)) result.hdr = "HDR";
        if (/\b(atmos|truehd)\b/.test(s)) result.audio = "Atmos";
        else if (/\bdts[-\s]?hd\b/.test(s)) result.audio = "DTS-HD";
        else if (/\bdts\b/.test(s)) result.audio = "DTS";
        else if (/\b(e?aac)\b/.test(s)) result.audio = "AAC";
        else if (/\b(flac|lpcm)\b/.test(s)) result.audio = "FLAC";
        var chMatch = s.match(/\b[257]\.1\b/);
        if (chMatch) result.channels = chMatch[0];
        if (/\bremux\b/.test(s)) result.isRemux = true;
        else if (/\b(web[\s.-]?dl|webrip)\b/.test(s)) result.isWebdl = true;
        else if (/\b(blu[\s.-]?ray|bdrip|brrip|bdr)\b/.test(s)) result.isBluray = true;
        if (/\b3d\b/.test(s) || /\b[hs]?sbs\b/.test(s)) result.is3D = true;
        if (/\b\[?RD\]?\b/.test(s)) result.debrid = "RD";
        else if (/\b\[?AD\]?\b/.test(s)) result.debrid = "AD";
        else if (/\b\[?PM\]?\b/.test(s)) result.debrid = "PM";
        return result;
    }

    function formatStreamLabel(features, addonName) {
        var parts = [];
        if (features.debrid) parts.push("[" + features.debrid + "]");
        parts.push(addonName);
        if (features.resolution !== "Auto") parts.push(features.resolution);
        if (features.hdr) parts.push(features.hdr);
        if (features.codec) parts.push(features.codec);
        if (features.audio) parts.push(features.audio);
        if (features.channels) parts.push(features.channels);
        if (features.isRemux) parts.push("REMUX");
        else if (features.isBluray) parts.push("BluRay");
        else if (features.isWebdl) parts.push("WEB-DL");
        if (features.is3D) parts.push("3D");
        return parts.join(" ");
    }

    // ============================================================
    //  SUBTITLE NORMALIZATION
    // ============================================================
    function normalizeLang(code) {
        if (!code) return "Unknown";
        var key = code.split("-")[0].toLowerCase();
        return LANG_MAP[key] || key.toUpperCase() || code;
    }

    // ============================================================
    //  STREAM PROCESSING
    // ============================================================
    async function processStreamResponse(streams, addonName, baseUrl) {
        if (!streams || !Array.isArray(streams)) return [];
        var trackers = await getTrackers();
        var results = [];

        for (var s = 0; s < streams.length; s++) {
            var stream = streams[s];
            if (!stream) continue;

            var rawName = stream.name ? stream.name.replace(/\n/g, " ").trim() : "";
            var rawTitle = stream.title ? stream.title.replace(/\n/g, " ").trim() : "";
            var rawDesc = stream.description ? stream.description.replace(/\n/g, " ").trim() : "";
            var featureText = rawName + " " + rawTitle + " " + rawDesc;
            var features = parseStreamFeatures(featureText);

            var titleText = rawTitle || rawName || "";
            var hasRichInfo = titleText.length > 10;
            var cleanSource;
            if (hasRichInfo) {
                var cleanedTitle = titleText.replace(/^\s*(4k|2160p?|uhd|1440p?|1080p?|720p?|480p?|360p?)\s*[-–—|:\s]*/i, "").trim();
                if (cleanedTitle) {
                    var addonPrefix = addonName;
                    if (cleanedTitle.toLowerCase().indexOf(addonName.toLowerCase()) === 0) addonPrefix = "";
                    cleanSource = (addonPrefix ? addonPrefix + " " : "") + cleanedTitle;
                } else {
                    cleanSource = formatStreamLabel(features, addonName);
                }
            } else {
                cleanSource = formatStreamLabel(features, addonName);
            }

            // --- 1) DIRECT HTTP(S) URL ---
            if (stream.url && isValidHttpUrl(stream.url)) {
                var headers = { "Referer": baseUrl + "/", "User-Agent": USER_AGENT };
                var bh = stream.behaviorHints || {};
                if (bh.proxyHeaders && bh.proxyHeaders.request) headers = Object.assign(headers, bh.proxyHeaders.request);
                else if (bh.headers) headers = Object.assign(headers, bh.headers);
                if (stream.url.indexOf(".m3u8") !== -1 || stream.url.indexOf(".mpd") !== -1) {
                    if (!headers["Origin"]) {
                        try { var u = new URL(stream.url); headers["Origin"] = u.protocol + "//" + u.hostname; } catch (e) {}
                    }
                }
                var subtitles = undefined;
                if (stream.subtitles && Array.isArray(stream.subtitles) && stream.subtitles.length > 0) {
                    subtitles = stream.subtitles.map(function(sub) { return { url: sub.url, lang: normalizeLang(sub.lang), label: normalizeLang(sub.lang) }; });
                }
                results.push(new StreamResult({
                    url: stream.url, quality: features.resolution, source: cleanSource,
                    headers: headers, subtitles: subtitles || undefined,
                    behaviorHints: bh, cached: stream.cached || false, size: stream.size || null
                }));
                continue;
            }

            // --- 2) TORRENT (infoHash) ---
            if (stream.infoHash) {
                var magnetUrl = buildMagnetLink(stream.infoHash, stream.sources, trackers);
                results.push(new StreamResult({
                    url: magnetUrl, quality: features.resolution, source: cleanSource,
                    infoHash: stream.infoHash, fileIndex: stream.fileIdx !== undefined ? stream.fileIdx : 0,
                    cached: stream.cached || false, size: stream.size || null,
                    behaviorHints: stream.behaviorHints || { notWebReady: true },
                    headers: { "User-Agent": USER_AGENT, "Referer": baseUrl + "/" }
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
                    url: stream.externalUrl, quality: features.resolution, source: addonName + " External",
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
                var fbProps = { url: fbUrl, quality: features.resolution, source: cleanSource, headers: { "User-Agent": USER_AGENT, "Referer": baseUrl + "/" }, behaviorHints: stream.behaviorHints || undefined };
                if (fbHash) { fbProps.infoHash = fbHash; fbProps.fileIndex = stream.fileIdx !== undefined ? stream.fileIdx : 0; }
                results.push(new StreamResult(fbProps));
            }
        }
        return results;
    }

    // ============================================================
    //  MAGNET LINK BUILDER
    // ============================================================
    function buildMagnetLink(infoHash, sources, trackers) {
        var magnet = "magnet:?xt=urn:btih:" + infoHash + "&dn=" + encodeURIComponent(infoHash);
        if (sources && Array.isArray(sources)) {
            for (var si = 0; si < sources.length; si++) {
                var src = sources[si];
                var trackerUrl = src.indexOf("tracker:") === 0 ? src.substring("tracker:".length) : src;
                if (trackerUrl) magnet += "&tr=" + encodeURIComponent(trackerUrl);
            }
        }
        var maxTrackers = 15, added = 0;
        for (var ti = 0; ti < trackers.length && added < maxTrackers; ti++) {
            if (magnet.indexOf("&tr=" + encodeURIComponent(trackers[ti])) === -1) {
                magnet += "&tr=" + encodeURIComponent(trackers[ti]); added++;
            }
        }
        return magnet;
    }

    // ============================================================
    //  META TO MEDIA ITEM CONVERSION
    // ============================================================
    function metaToMultimediaItem(meta, addonConfig, catalogType) {
        if (!meta) return null;
        var type = meta.type || catalogType || "movie";
        var skystreamType = (type === "series" || type === "tv" || type === "anime" || type === "hentai") ? "series" : "movie";
        var poster = meta.poster || "";
        var background = meta.background || meta.backdrop || "";
        var description = meta.description ? meta.description.replace(/<[^>]*>/g, "").trim().substring(0, 500) : "";
        return new MultimediaItem({
            title: meta.name || meta.title || "Unknown",
            url: encodeUrl(addonConfig.baseUrl, type, meta.id, 0, 0, poster, meta.name || meta.title),
            posterUrl: poster, bannerUrl: background, type: skystreamType,
            description: description,
            year: meta.year ? parseInt(meta.year) : (meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined),
            score: meta.imdbRating ? parseFloat(meta.imdbRating) : (meta.score || meta.popularity || undefined)
        });
    }

    // ============================================================
    //  getHome
    // ============================================================
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
                var allCatalogPromises = [];
                addonConfigs.forEach(function(config) {
                    config.catalogs.forEach(function(catalogEntry) {
                        allCatalogPromises.push((async function() {
                            try {
                                var metas = await fetchCatalog(config, catalogEntry, ITEMS_PER_CATALOG, 0);
                                if (!metas || metas.length === 0) return null;
                                var items = metas.map(function(meta) { return metaToMultimediaItem(meta, config, catalogEntry.type); }).filter(function(item) { return item !== null; });
                                if (items.length === 0) return null;
                                var sectionName = config.name;
                                var catName = catalogEntry.name || catalogEntry.id;
                                if (catName && catName !== config.name) sectionName = config.name + " - " + catName;
                                return { name: sectionName, items: items };
                            } catch (e) { return null; }
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
                var firstConfig = addonConfigs[0];
                if (firstConfig) {
                    var skipAmount = (pageNum - 1) * ITEMS_PER_CATALOG;
                    var pagePromises = firstConfig.catalogs.map(function(catalogEntry) {
                        return (async function() {
                            try {
                                var metas = await fetchCatalog(firstConfig, catalogEntry, ITEMS_PER_CATALOG, skipAmount);
                                if (!metas || metas.length === 0) return null;
                                var items = metas.map(function(meta) { return metaToMultimediaItem(meta, firstConfig, catalogEntry.type); }).filter(function(item) { return item !== null; });
                                if (items.length === 0) return null;
                                var sectionName = firstConfig.name + " - " + (catalogEntry.name || catalogEntry.id) + " (Page " + pageNum + ")";
                                return { name: sectionName, items: items };
                            } catch (e) { return null; }
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
            var orderedData = {};
            sectionOrder.forEach(function(n) { if (homeSections[n]) orderedData[n] = homeSections[n]; });
            cb({ success: true, data: orderedData, page: pageNum });
        } catch (e) {
            log("error", "getHome error", e.message);
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message });
        }
    }

    // ============================================================
    //  FIXED: search across ALL addons (no longer just search-declared ones)
    // ============================================================
    async function search(query, cb) {
        try {
            var q = String(query || "").trim();
            if (!q) return cb({ success: true, data: [] });

            var addonConfigs = await getAddonConfigs();
            var allResults = [];

            if (addonConfigs.length > 0) {
                var searchPromises = addonConfigs.map(function(config) {
                    return (async function() {
                        var results = [];
                        // First: only try catalogs that DECLARE search support via extra[].
                        // Non-search catalogs ignore the search param and return all items!
                        var searchCatalogs = config.catalogs.filter(function(cat) {
                            if (cat.extra) {
                                for (var x = 0; x < cat.extra.length; x++) {
                                    if (cat.extra[x].name === "search") return true;
                                }
                            }
                            return false;
                        });
                        // If none declared search, try generic type-based search as a guess
                        if (searchCatalogs.length === 0) {
                            for (var ti = 0; ti < config.types.length; ti++) {
                                var t = config.types[ti];
                                var genUrl = config.baseUrl + "/catalog/" + t + "/top/search=" + encodeURIComponent(q) + ".json";
                                var genData = await fetchWithTimeout(genUrl, HEADERS, ADDON_TIMEOUT_MS);
                                if (genData && genData.metas && genData.metas.length > 0) {
                                    // Verify results actually match the query (addon may ignore search param)
                                    var queryLower = q.toLowerCase();
                                    var filtered = genData.metas.filter(function(m) {
                                        return m.name && m.name.toLowerCase().indexOf(queryLower) !== -1;
                                    });
                                    if (filtered.length > 0) {
                                        filtered.forEach(function(meta) {
                                            var item = metaToMultimediaItem(meta, config, t);
                                            if (item) results.push(item);
                                        });
                                        break;
                                    }
                                }
                            }
                        } else {
                            // Use only search-declared catalogs, query ALL in parallel with shorter timeout
                            var catPromises = searchCatalogs.map(function(cat) {
                                var url = config.baseUrl + "/catalog/" + cat.type + "/" + cat.id + "/search=" + encodeURIComponent(q) + ".json";
                                return fetchWithTimeout(url, HEADERS, 8000).then(function(data) {
                                    if (data && data.metas && data.metas.length > 0) {
                                        return data.metas.map(function(meta) {
                                            return metaToMultimediaItem(meta, config, cat.type);
                                        }).filter(function(item) { return item !== null; });
                                    }
                                    return [];
                                });
                            });
                            var catResults = await Promise.allSettled(catPromises);
                            catResults.forEach(function(r) {
                                if (r.status === "fulfilled" && r.value) results = results.concat(r.value);
                            });
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
            }

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
            log("error", "search error", e.message);
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message });
        }
    }

    // ============================================================
    //  load
    // ============================================================
    async function load(url, cb) {
        try {
            var decoded = decodeUrl(url);
            if (!decoded) {
                return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid URL format" });
            }

            var addonUrl = decoded.a;
            var type = decoded.t;
            var id = decoded.i;
            var fallbackPoster = decoded.p || "";
            var fallbackTitle = decoded.n || "";

            var metaUrl = addonUrl + "/meta/" + type + "/" + encodeURIComponent(id) + ".json";
            var data = await fetchWithTimeout(metaUrl, HEADERS, ADDON_TIMEOUT_MS);

            if (data && data.meta && (data.meta.name || data.meta.title)) {
                var meta = data.meta;
                var skystreamType = (type === "series" || type === "tv" || type === "anime" || type === "hentai") ? "series" : "movie";
                var episodes = [];
                if (meta.videos && Array.isArray(meta.videos)) {
                    meta.videos.forEach(function(video) {
                        var epUrl = encodeUrl(addonUrl, type, video.id || id, video.season || 1, video.episode || video.number || 1);
                        episodes.push(new Episode({
                            name: video.title || video.name || "Episode " + (video.episode || video.number || 1),
                            url: epUrl, season: video.season || 1, episode: video.episode || video.number || 1,
                            posterUrl: video.thumbnail || meta.poster || "", description: video.description || "", airDate: video.released || ""
                        }));
                    });
                }
                if (episodes.length === 0) {
                    episodes.push(new Episode({
                        name: skystreamType === "movie" ? "Full Movie" : "Watch", url: url, season: 1, episode: 1,
                        posterUrl: meta.poster || "", description: (meta.description || "").replace(/<[^>]*>/g, "").trim()
                    }));
                }
                return cb({ success: true, data: new MultimediaItem({
                    title: meta.name || meta.title || meta.englishName || "Unknown", url: url,
                    posterUrl: meta.poster || "", bannerUrl: meta.background || meta.backdrop || "",
                    logoUrl: meta.logo || "", type: skystreamType,
                    description: (meta.description || "").replace(/<[^>]*>/g, "").trim(),
                    year: meta.year ? parseInt(meta.year) : (meta.releaseInfo ? parseInt(meta.releaseInfo) : undefined),
                    score: meta.score || (meta.imdbRating ? parseFloat(meta.imdbRating) : undefined),
                    genres: meta.genres || meta.tags || undefined,
                    status: meta.status ? (meta.status.toLowerCase().indexOf("releasing") !== -1 || meta.status.toLowerCase().indexOf("ongoing") !== -1 ? "ongoing" : "completed") : undefined,
                    episodes: episodes
                })});
            }

            // Fallback: use stored poster/title from URL (preserved from search/catalog)
            // Clean up the ID for display - strip prefixes like "tt", "hmm-", "htv-", etc.
            var displayId = id.replace(/^([a-z]+[-:])+/, "").replace(/[-_]/g, " ").replace(/\b\w/g, function(c) { return c.toUpperCase(); }).substring(0, 60);
            var fbType = (type === "series" || type === "tv" || type === "anime" || type === "hentai") ? "series" : "movie";
            cb({ success: true, data: new MultimediaItem({
                title: fallbackTitle || displayId || "Content",
                url: url, posterUrl: fallbackPoster, type: fbType,
                description: "Browse streams from source addon.",
                episodes: [new Episode({ name: fbType === "movie" ? "Full Movie" : "Watch", url: url, season: 1, episode: 1 })]
            })});
        } catch (e) {
            log("error", "load error", e.message);
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message });
        }
    }

    // ============================================================
    //  loadStreams
    // ============================================================
    async function loadStreams(url, cb) {
        try {
            var decoded = decodeUrl(url);
            if (!decoded) {
                return cb({ success: true, data: [new StreamResult({ url: url, quality: "Auto", source: "Direct", headers: HEADERS })] });
            }

            var addonUrl = decoded.a;
            var type = decoded.t;
            var id = decoded.i;
            var season = decoded.s;
            var episode = decoded.e;

            var cacheKey = addonUrl + ":" + type + ":" + id + ":" + season + ":" + episode;
            var cached = streamResultCache[cacheKey];
            if (cached && (Date.now() - cached.ts) < STREAM_CACHE_TTL) {
                return cb({ success: true, data: cached.data });
            }

            var addonName = extractSourceName(addonUrl);
            var startTime = Date.now();

            var urlsToTry = [addonUrl + "/stream/" + type + "/" + encodeURIComponent(id) + ".json"];
            if ((type === "series" || type === "anime" || type === "hentai") && season > 0 && episode > 0) {
                urlsToTry.push(addonUrl + "/stream/" + type + "/" + encodeURIComponent(id) + ":" + season + ":" + episode + ".json");
                urlsToTry.push(addonUrl + "/stream/movie/" + encodeURIComponent(id) + ".json");
            }

            var rawStreams = [];
            for (var ui = 0; ui < urlsToTry.length; ui++) {
                var streamData = await fetchWithTimeout(urlsToTry[ui], HEADERS, ADDON_TIMEOUT_MS);
                if (streamData && streamData.streams && Array.isArray(streamData.streams) && streamData.streams.length > 0) {
                    rawStreams = streamData.streams;
                    break;
                }
            }

            var streams = await processStreamResponse(rawStreams, addonName, addonUrl);

            // Deduplicate
            var seen = {};
            streams = streams.filter(function(s) {
                var key = s.infoHash || s.url;
                if (!key) return true;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            });

            // Sort by quality
            var qOrder = { "4K": 0, "2160p": 0, "1440p": 1, "1080p": 2, "720p": 3, "480p": 4, "360p": 5, "YouTube": 6, "Auto": 7 };
            streams.sort(function(a, b) {
                var qa = qOrder[a.quality] !== undefined ? qOrder[a.quality] : 7;
                var qb = qOrder[b.quality] !== undefined ? qOrder[b.quality] : 7;
                if (qa !== qb) return qa - qb;
                if (a.cached && !b.cached) return -1;
                if (!a.cached && b.cached) return 1;
                return 0;
            });

            log("info", "Found " + streams.length + " streams for " + id + " in " + (Date.now() - startTime) + "ms");

            streamResultCache[cacheKey] = { ts: Date.now(), data: streams };
            var keys = Object.keys(streamResultCache);
            if (keys.length > 50) {
                var sorted = keys.sort(function(a, b) { return streamResultCache[a].ts - streamResultCache[b].ts; });
                for (var i = 0; i < sorted.length - 50; i++) delete streamResultCache[sorted[i]];
            }

            cb({ success: true, data: streams });
        } catch (e) {
            log("error", "loadStreams error", e.message);
            cb({ success: true, data: [] });
        }
    }

    // ============================================================
    //  HELPERS
    // ============================================================
    function extractSourceName(addonUrl) {
        try {
            var hostname = addonUrl.replace(/https?:\/\//, "").split("/")[0].replace(/^www\./, "");
            var parts = hostname.split(".");
            if (parts.length >= 2) {
                var tlds = ["com", "org", "net", "io", "app", "dev", "tv", "co", "uk", "de", "xyz", "fun", "cloud", "me"];
                var best = parts[0];
                if (tlds.indexOf(best) !== -1 && parts.length > 1) best = parts[1];
                return best.charAt(0).toUpperCase() + best.slice(1);
            }
            return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        } catch (e) { return "Addon"; }
    }

    // ============================================================
    //  INIT - Pre-warm trackers
    // ============================================================
    var trackerInit = getTrackers();
    trackerInit.then(function(t) { log("info", "Tracker cache warmed: " + t.length + " trackers"); }).catch(function() {});

    // ============================================================
    //  EXPORTS
    // ============================================================
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

    log("info", "StremioNsfw v3 loaded. " + getAddonUrls().length + " addons configured.");
})();

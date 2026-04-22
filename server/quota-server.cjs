const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

// ===== CLI flags =====
const AUTO_OPEN_BROWSER = process.argv.includes('--open');

// ===== Load .env file =====
function loadEnv() {
  const envPath = path.join(__dirname, '.env.quota');
  const env = {};
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        let val = line.substring(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    });
  }
  return env;
}

const DEFAULT_PORT = 3210;
const MAX_PORT_ATTEMPTS = 10; // Try up to 10 ports
let PORT = DEFAULT_PORT;

// ===== Cursor Token Helper =====
// Extract WorkosCursorSessionToken from full cookie string or raw token value
function extractCursorToken(cookieOrToken) {
  if (!cookieOrToken) return null;
  // If it contains WorkosCursorSessionToken=, extract its value
  const match = cookieOrToken.match(/WorkosCursorSessionToken=([^;]+)/);
  if (match) return match[1];
  // If it looks like a raw token (user_xxx::jwt or url-encoded), use as-is
  if (cookieOrToken.includes('user_') || cookieOrToken.includes('eyJ')) return cookieOrToken;
  return null;
}

// Parse JWT expiry from WorkosCursorSessionToken
function checkCursorTokenExpiry(cookieOrToken) {
  try {
    const token = extractCursorToken(cookieOrToken);
    if (!token) return { valid: false, error: 'No token found' };
    // Decode URL encoding: user_xxx%3A%3Ajwt -> user_xxx::jwt
    const decoded = decodeURIComponent(token);
    const parts = decoded.split('::');
    if (parts.length < 2) return { valid: false, error: 'Invalid token format' };
    const jwt = parts[1];
    // Decode JWT payload (base64url)
    const payloadB64 = jwt.split('.')[1];
    if (!payloadB64) return { valid: false, error: 'Invalid JWT' };
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const exp = payload.exp;
    if (!exp) return { valid: true, warning: 'No expiry in token' };
    const expDate = new Date(exp * 1000);
    const now = new Date();
    const daysLeft = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));
    return {
      valid: daysLeft > 0,
      expiresAt: expDate.toISOString(),
      daysLeft,
      expired: daysLeft <= 0,
      warning: daysLeft <= 7 ? `Token expires in ${daysLeft} day(s)` : null,
    };
  } catch (e) {
    return { valid: false, error: 'Failed to parse token: ' + e.message };
  }
}

// ===== HTTPS request helper with redirect following =====
function httpsRequest(url, options = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        ...options.headers,
      },
    };

    const req = https.request(reqOptions, (res) => {
      // Follow redirects (unless maxRedirects is 0)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        let location = res.headers.location;
        if (location.startsWith('/')) {
          location = parsedUrl.protocol + '//' + parsedUrl.hostname + location;
        }
        res.resume();
        console.log(`  [Redirect] ${res.statusCode} -> ${location}`);
        httpsRequest(location, options, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          redirected: res.statusCode >= 300 && res.statusCode < 400,
          location: res.headers.location || null,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout (10s)'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ===== Cursor API =====
// Build the minimal cookie header for Cursor API (only WorkosCursorSessionToken needed)
function buildCursorCookie(env) {
  const raw = env.CURSOR_COOKIE;
  if (!raw) return null;
  const token = extractCursorToken(raw);
  if (!token) return null;
  // Always send as WorkosCursorSessionToken=xxx
  if (token.startsWith('WorkosCursorSessionToken=')) return token;
  return `WorkosCursorSessionToken=${token}`;
}

// Confirmed working: GET https://cursor.com/api/usage
async function fetchCursorUsageRaw(env) {
  const cookie = buildCursorCookie(env);
  if (!cookie) {
    return { error: 'CURSOR_COOKIE not configured', hint: 'Paste WorkosCursorSessionToken value or full cookie from cursor.com DevTools' };
  }

  try {
    // Use cursor.com directly (www.cursor.com redirects with 308)
    // Note: Do NOT include Referer header - it causes the request to hang
    const res = await httpsRequest('https://cursor.com/api/usage', {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    });

    if (res.status === 200) {
      try {
        const data = JSON.parse(res.body);
        return { success: true, data };
      } catch {
        return { error: 'Invalid JSON response - token may be expired', status: res.status };
      }
    } else if (res.status === 401 || res.status === 403) {
      return { error: 'Authentication failed - token expired, please update CURSOR_COOKIE in .env', status: res.status };
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// GET https://cursor.com/api/usage-summary - more detailed usage breakdown
async function fetchCursorUsageSummary(env) {
  const cookie = buildCursorCookie(env);
  if (!cookie) return { error: 'CURSOR_COOKIE not configured' };

  try {
    const res = await httpsRequest('https://cursor.com/api/usage-summary', {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    });

    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        return { error: 'Invalid JSON from usage-summary', status: res.status };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// GET https://cursor.com/api/dashboard/get-user-api-keys - user's API keys
async function fetchCursorApiKeys(env) {
  const cookie = buildCursorCookie(env);
  if (!cookie) return { error: 'CURSOR_COOKIE not configured' };

  try {
    const res = await httpsRequest('https://cursor.com/api/dashboard/get-user-api-keys', {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    });

    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        return { error: 'Invalid JSON from get-user-api-keys', status: res.status };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// Aggregate all Cursor APIs into one result
async function fetchCursorUsage(env) {
  const cookie = buildCursorCookie(env);
  if (!cookie) {
    return { error: 'CURSOR_COOKIE not configured', hint: 'Paste WorkosCursorSessionToken value or full cookie from cursor.com DevTools' };
  }

  // Check token expiry before making requests
  const tokenStatus = checkCursorTokenExpiry(env.CURSOR_COOKIE);
  if (tokenStatus.expired) {
    return {
      error: 'Cursor token has expired',
      hint: 'Please update CURSOR_COOKIE in .env with a fresh token from cursor.com',
      tokenStatus,
    };
  }

  const [usageResult, summaryResult, apiKeysResult] = await Promise.all([
    fetchCursorUsageRaw(env),
    fetchCursorUsageSummary(env),
    fetchCursorApiKeys(env),
  ]);

  // If the primary usage API fails, return its error
  if (!usageResult.success) {
    return { ...usageResult, tokenStatus };
  }

  // Merge all data into a single response
  const mergedData = {
    ...usageResult.data,
    _usageSummary: summaryResult.success ? summaryResult.data : { _error: summaryResult.error },
    _apiKeys: apiKeysResult.success ? apiKeysResult.data : { _error: apiKeysResult.error },
    _tokenStatus: tokenStatus,
  };

  return { success: true, data: mergedData };
}

// ===== CodeBuddy Plugin API =====
const CB_PLUGIN_BASE = 'https://tokens-nbyxw43y.app.with.woa.com';
const CB_PLUGIN_PLATFORMS = 'codebuddy,with,codebuddy-code,codebuddy-cli,codex-internal,xcode';

// GET /api/user - user info & token balance
async function fetchCBPluginUser(env) {
  const cookie = env.CODEBUDDY_PLUGIN_COOKIE;
  if (!cookie) return { error: 'CODEBUDDY_PLUGIN_COOKIE not configured' };

  try {
    // Don't follow redirects - 302 means cookie expired
    const res = await httpsRequest(`${CB_PLUGIN_BASE}/api/user`, {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    }, 0);

    if (res.redirected) {
      return { error: 'Redirected to login - cookie expired', status: res.status };
    }

    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        return { error: 'Invalid JSON from /api/user - cookie may be expired', status: res.status };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// GET /api/usage-summary - usage summary by platform (personal dimension)
// platformOverride: optional, if provided use this instead of CB_PLUGIN_PLATFORMS
async function fetchCBPluginUsageSummary(env, platformOverride) {
  const cookie = env.CODEBUDDY_PLUGIN_COOKIE;
  if (!cookie) return { error: 'CODEBUDDY_PLUGIN_COOKIE not configured' };

  // Build date range: from 1st of current month to today
  const now = new Date();
  const startDate = now.toISOString().substring(0, 8) + '01';
  const endDate = now.toISOString().substring(0, 10);
  const platforms = encodeURIComponent(platformOverride || CB_PLUGIN_PLATFORMS);
  const url = `${CB_PLUGIN_BASE}/api/usage-summary?start_date=${startDate}&end_date=${endDate}&dimension=personal&platform=${platforms}`;

  try {
    // Use Promise.race with a 15s timeout since this API can be slow
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('usage-summary API timeout (15s)')), 15000)
    );

    const fetchPromise = httpsRequest(url, {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    }, 0);

    const res = await Promise.race([fetchPromise, timeoutPromise]);

    if (res.redirected) {
      return { error: 'Redirected to login - cookie expired', status: res.status };
    }

    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        return { error: 'Invalid JSON from /api/usage-summary', status: res.status };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// GET /api/query-quota - query remaining quota percentage
async function fetchCBPluginQueryQuota(env, platform = 'codebuddy') {
  const cookie = env.CODEBUDDY_PLUGIN_COOKIE;
  if (!cookie) return { error: 'CODEBUDDY_PLUGIN_COOKIE not configured' };

  const url = `${CB_PLUGIN_BASE}/api/query-quota?platform=${encodeURIComponent(platform)}`;

  try {
    const res = await httpsRequest(url, {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    }, 0);

    if (res.redirected) {
      return { error: 'Redirected to login - cookie expired', status: res.status };
    }

    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        return { error: 'Invalid JSON from /api/query-quota', status: res.status };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// GET /api/platforms - get platform categories list
async function fetchCBPluginPlatforms(env) {
  const cookie = env.CODEBUDDY_PLUGIN_COOKIE;
  if (!cookie) return { error: 'CODEBUDDY_PLUGIN_COOKIE not configured' };

  try {
    const res = await httpsRequest(`${CB_PLUGIN_BASE}/api/platforms`, {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    }, 0);

    if (res.redirected) {
      return { error: 'Redirected to login - cookie expired', status: res.status };
    }

    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        return { error: 'Invalid JSON from /api/platforms', status: res.status };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// GET /api/quota-allocation - get quota allocation settings per category
async function fetchCBPluginQuotaAllocation(env) {
  const cookie = env.CODEBUDDY_PLUGIN_COOKIE;
  if (!cookie) return { error: 'CODEBUDDY_PLUGIN_COOKIE not configured' };

  try {
    const res = await httpsRequest(`${CB_PLUGIN_BASE}/api/quota-allocation`, {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    }, 0);

    if (res.redirected) {
      return { error: 'Redirected to login - cookie expired', status: res.status };
    }

    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        return { error: 'Invalid JSON from /api/quota-allocation', status: res.status };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// Aggregate CodeBuddy Plugin APIs
async function fetchCodeBuddyPluginUsage(env) {
  const cookie = env.CODEBUDDY_PLUGIN_COOKIE;

  // Try server-side fetch with cookie first
  if (cookie) {
    const userResult = await fetchCBPluginUser(env);
    if (userResult.success) {
      // Cookie works - fetch usage summary, quota, and platforms in parallel
      console.log('  [CB Plugin] User API OK, fetching usage-summary, query-quota, platforms, quota-allocation...');
      const [usageResult, quotaResult, platformsResult, allocationResult] = await Promise.all([
        fetchCBPluginUsageSummary(env),
        fetchCBPluginQueryQuota(env, 'codebuddy'),
        fetchCBPluginPlatforms(env),
        fetchCBPluginQuotaAllocation(env),
      ]);
      if (!usageResult.success) {
        console.log('  [CB Plugin] usage-summary failed:', usageResult.error);
      }
      if (!quotaResult.success) {
        console.log('  [CB Plugin] query-quota failed:', quotaResult.error);
      }
      if (!platformsResult.success) {
        console.log('  [CB Plugin] platforms failed:', platformsResult.error);
      }
      if (!allocationResult.success) {
        console.log('  [CB Plugin] quota-allocation failed:', allocationResult.error);
      }

      // If we have platforms, fetch per-category quota AND per-category usage-summary for each category
      let categoryQuotas = [];
      if (platformsResult.success && platformsResult.data && platformsResult.data.categories) {
        const categories = platformsResult.data.categories;
        console.log(`  [CB Plugin] Fetching quota and usage for ${categories.length} categories...`);
        const categoryQuotaPromises = categories.map(async (cat) => {
          const firstPlatform = (cat.platforms || cat.value.split(','))[0] || cat.value.split(',')[0];
          // Fetch quota for this category
          const quotaResult = await fetchCBPluginQueryQuota(env, firstPlatform.trim());
          // Fetch usage-summary for this category's platforms to get accurate cost
          const catUsageResult = await fetchCBPluginUsageSummary(env, cat.value);
          let catCost = 0;
          if (catUsageResult.success && catUsageResult.data) {
            const items = Array.isArray(catUsageResult.data.data) ? catUsageResult.data.data : [];
            items.forEach(item => {
              const costStr = item.cost || '$0.00';
              catCost += parseFloat(costStr.replace(/[^0-9.]/g, '')) || 0;
            });
          }
          return {
            label: cat.label,
            value: cat.value,
            description: cat.description || '',
            quota: quotaResult.success ? quotaResult.data : { _error: quotaResult.error },
            categoryCost: catCost,
          };
        });
        categoryQuotas = await Promise.all(categoryQuotaPromises);
      }

      // Debug: log usage-summary data structure
      if (usageResult.success && usageResult.data) {
        const usageData = usageResult.data;
        const items = Array.isArray(usageData.data) ? usageData.data : (Array.isArray(usageData) ? usageData : []);
        console.log(`  [CB Debug] usage-summary items count: ${items.length}`);
        if (items.length > 0) {
          console.log(`  [CB Debug] usage-summary first item keys: ${Object.keys(items[0]).join(', ')}`);
          console.log(`  [CB Debug] usage-summary first 3 items:`, JSON.stringify(items.slice(0, 3).map(i => ({ platform: i.platform, type: i.type, model_name: i.model_name, cost: i.cost, product_group: i.product_group }))));
          console.log(`  [CB Debug] usage-summary all unique platforms:`, JSON.stringify([...new Set(items.map(i => i.platform || 'NONE'))]));
          console.log(`  [CB Debug] usage-summary all unique types:`, JSON.stringify([...new Set(items.map(i => i.type || 'NONE'))]));
        }
      }
      // Debug: log platforms categories
      if (platformsResult.success && platformsResult.data && platformsResult.data.categories) {
        console.log(`  [CB Debug] platforms categories:`, JSON.stringify(platformsResult.data.categories.map(c => ({ label: c.label, value: c.value }))));
      }
      // Debug: log allocation items
      if (allocationResult.success && allocationResult.data && allocationResult.data.data && allocationResult.data.data.items) {
        console.log(`  [CB Debug] allocation items:`, JSON.stringify(allocationResult.data.data.items.map(a => ({ label: a.label, product_group: a.product_group, quota_disabled: a.quota_disabled, total_cost: a.total_cost }))));
      }

      const mergedData = {
        _user: userResult.data,
        _usageSummary: usageResult.success ? usageResult.data : { _error: usageResult.error },
        _totalQuota: quotaResult.success ? quotaResult.data : { _error: quotaResult.error },
        _platforms: platformsResult.success ? platformsResult.data : { _error: platformsResult.error },
        _categoryQuotas: categoryQuotas,
        _quotaAllocation: allocationResult.success ? allocationResult.data : { _error: allocationResult.error },
      };

      return { success: true, data: mergedData };
    }
    console.log('  [CB Plugin] Cookie expired, checking browser cache...');
  }

  // Fallback: use browser-cached data (from /oa-capture page)
  if (cbPluginBrowserCache && (Date.now() - cbPluginBrowserCacheTime) < CB_PLUGIN_CACHE_TTL) {
    console.log('  [CB Plugin] Using browser-cached data (age: ' + Math.round((Date.now() - cbPluginBrowserCacheTime) / 1000) + 's)');
    const mergedData = {
      _user: cbPluginBrowserCache.user,
      _usageSummary: cbPluginBrowserCache.usageSummary || { _error: 'Not available' },
      _totalQuota: cbPluginBrowserCache.totalQuota || { _error: 'Not available' },
      _platforms: cbPluginBrowserCache.platforms || { _error: 'Not available' },
      _categoryQuotas: cbPluginBrowserCache.categoryQuotas || [],
      _quotaAllocation: cbPluginBrowserCache.quotaAllocation || { _error: 'Not available' },
      _fromBrowserCache: true,
    };
    return { success: true, data: mergedData };
  }

  if (!cookie) {
    return { error: 'CODEBUDDY_PLUGIN_COOKIE not configured', hint: 'Click Renew OA to login and auto-capture data' };
  }
  return { error: 'Cookie expired and no browser cache available', hint: 'Click Renew OA to refresh' };
}

// ===== CodeBuddy IDE API =====
const CB_IDE_BASE = 'https://tencent.sso.codebuddy.cn';
const CB_IDE_PRODUCT_CODE = 'codebuddy_personal_pro_cn_208177';

// POST /billing/meter/get-enterprise-user-usage - get cycle usage summary
async function fetchCBIDEEnterpriseUsage(env) {
  const cookie = env.CODEBUDDY_IDE_COOKIE;
  if (!cookie) return { error: 'CODEBUDDY_IDE_COOKIE not configured' };

  try {
    const res = await httpsRequest(`${CB_IDE_BASE}/billing/meter/get-enterprise-user-usage`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    if (res.redirected || res.status === 302) {
      return { error: 'Cookie expired - redirected to login', status: 302 };
    }
    if (res.status === 401) {
      return { error: 'Authentication failed - cookie expired', status: 401 };
    }
    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        if (res.body.includes('<html') || res.body.includes('<!DOCTYPE')) {
          return { error: 'Cookie expired - got HTML instead of JSON', status: res.status };
        }
        return { error: 'Invalid JSON from get-enterprise-user-usage', status: res.status, body: res.body.substring(0, 300) };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// POST /billing/meter/get-user-resource - get user's resource/quota info
async function fetchCBIDEUserResource(env) {
  const cookie = env.CODEBUDDY_IDE_COOKIE;
  if (!cookie) return { error: 'CODEBUDDY_IDE_COOKIE not configured' };

  const now = new Date();
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 200,
    ProductCode: CB_IDE_PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: now.toISOString().replace('T', ' ').substring(0, 19),
    PackageEndTimeRangeEnd: new Date(now.getTime() + 101 * 365 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19),
  });

  try {
    const res = await httpsRequest(`${CB_IDE_BASE}/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body,
    });

    if (res.status === 401) {
      return { error: 'Authentication failed - cookie expired', status: 401 };
    }
    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        return { error: 'Invalid JSON from get-user-resource', status: res.status, body: res.body.substring(0, 300) };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// GET /console/accounts - get user account info
async function fetchCBIDEAccountInfo(env) {
  const cookie = env.CODEBUDDY_IDE_COOKIE;
  if (!cookie) return { error: 'CODEBUDDY_IDE_COOKIE not configured' };

  try {
    // Don't follow redirects - 302 means cookie expired
    const res = await httpsRequest(`${CB_IDE_BASE}/console/accounts`, {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
      },
    }, 0);

    if (res.redirected || res.status === 302) {
      return { error: 'Cookie expired - redirected to login', status: 302 };
    }
    if (res.status === 401) {
      return { error: 'Authentication failed - cookie expired', status: 401 };
    }
    if (res.status === 200) {
      try {
        return { success: true, data: JSON.parse(res.body) };
      } catch {
        // /console/accounts might return HTML even on 200 if not authenticated
        if (res.body.includes('<html') || res.body.includes('<!DOCTYPE')) {
          return { error: 'Cookie expired - got HTML instead of JSON', status: res.status };
        }
        return { error: 'Invalid JSON from /console/accounts', status: res.status };
      }
    } else {
      return { error: `HTTP ${res.status}`, body: res.body.substring(0, 500) };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// Aggregate all CodeBuddy IDE APIs
async function fetchCodeBuddyIDEUsage(env) {
  const cookie = env.CODEBUDDY_IDE_COOKIE;

  // Try server-side fetch with cookie first
  if (cookie) {
    console.log('  [CB IDE] Fetching enterprise usage + resource...');

    // Fetch enterprise usage (cycle total) and resource (cycle dates) in parallel
    const [enterpriseResult, resourceResult] = await Promise.all([
      fetchCBIDEEnterpriseUsage(env),
      fetchCBIDEUserResource(env),
    ]);

    if (!enterpriseResult.success) console.log('  [CB IDE] get-enterprise-user-usage failed:', enterpriseResult.error);
    if (!resourceResult.success) console.log('  [CB IDE] get-user-resource failed:', resourceResult.error);

    const anySuccess = enterpriseResult.success || resourceResult.success;

    if (anySuccess) {
      const mergedData = {
        _enterpriseUsage: enterpriseResult.success ? enterpriseResult.data : { _error: enterpriseResult.error },
        _resource: resourceResult.success ? resourceResult.data : { _error: resourceResult.error },
      };

      console.log('  [CB IDE] Data merged successfully');
      return { success: true, data: mergedData };
    }

    // All APIs failed - cookie is truly expired
    console.log('  [CB IDE] All APIs failed, cookie expired. Checking browser cache...');
  }

  // Fallback: use browser-cached data (from capture script)
  if (cbIDEBrowserCache && isCBIDECacheValid(cbIDEBrowserCache) && (Date.now() - cbIDEBrowserCacheTime) < CB_IDE_CACHE_TTL) {
    console.log('  [CB IDE] Using browser-cached data (age: ' + Math.round((Date.now() - cbIDEBrowserCacheTime) / 1000) + 's)');
    const mergedData = {
      _enterpriseUsage: cbIDEBrowserCache.enterpriseUsage || { _error: 'Not available' },
      _resource: cbIDEBrowserCache.resource || { _error: 'Not available' },
      _fromBrowserCache: true,
    };
    return { success: true, data: mergedData };
  }

  if (!cookie) {
    return { error: 'CODEBUDDY_IDE_COOKIE not configured', hint: 'Click Renew OA to login and auto-capture data' };
  }
  return { error: 'Cookie expired and no browser cache available', hint: 'Click Renew OA to refresh' };
}

// ===== OA Login Flow for CodeBuddy Plugin =====
// In-memory cache for CB Plugin data fetched via browser CORS
let cbPluginBrowserCache = null;
let cbPluginBrowserCacheTime = 0;
const CB_PLUGIN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ===== OA Login Flow for CodeBuddy IDE =====
// Persistent cache for CB IDE data fetched via browser capture script
let cbIDEBrowserCache = null;
let cbIDEBrowserCacheTime = 0;
const CB_IDE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CB_IDE_CACHE_FILE = path.join(__dirname, '.cb-ide-cache-quota.json');

// Load persisted CB IDE cache on startup
try {
  if (fs.existsSync(CB_IDE_CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(CB_IDE_CACHE_FILE, 'utf-8'));
    if (cached && cached.data && cached.timestamp) {
      cbIDEBrowserCache = cached.data;
      cbIDEBrowserCacheTime = cached.timestamp;
      const ageMin = Math.round((Date.now() - cached.timestamp) / 60000);
      console.log(`[CB IDE] Loaded persisted cache (age: ${ageMin}min)`);
    }
  }
} catch (e) {
  console.log('[CB IDE] No persisted cache found or invalid:', e.message);
}

// Helper: check if CB IDE cache data is valid (has actual API data, not null)
function isCBIDECacheValid(data) {
  if (!data) return false;
  return !!(data.enterpriseUsage || data.resource);
}

// Helper: persist CB IDE cache to file
function persistCBIDECache(data) {
  if (!isCBIDECacheValid(data)) {
    console.log('[CB IDE] Refusing to persist invalid cache (enterpriseUsage and resource are both null)');
    return false;
  }
  cbIDEBrowserCache = data;
  cbIDEBrowserCacheTime = Date.now();
  try {
    fs.writeFileSync(CB_IDE_CACHE_FILE, JSON.stringify({ data, timestamp: cbIDEBrowserCacheTime }, null, 2), 'utf-8');
    console.log('[CB IDE] Cache persisted to', CB_IDE_CACHE_FILE);
    return true;
  } catch (e) {
    console.log('[CB IDE] Failed to persist cache:', e.message);
    return false;
  }
}

// Get the OA login URL by hitting the CB Plugin API without cookie
async function getOALoginUrl() {
  try {
    const res = await httpsRequest(`${CB_PLUGIN_BASE}/api/user`, {
      headers: { 'Accept': 'application/json' },
    }, 0);
    if (res.redirected && res.location) {
      return { success: true, loginUrl: res.location };
    }
    return { error: 'Expected 302 redirect but got ' + res.status };
  } catch (e) {
    return { error: e.message };
  }
}

// Generate the OA capture page - this page runs in the popup after OA login
// It uses fetch with credentials:include to request tokens-site API via CORS
// Then sends the data back to our server
function generateOACapturePageHTML() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OA Token Capture</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#fafafa;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .card{background:#171717;border:1px solid #27272a;border-radius:12px;padding:32px;max-width:500px;text-align:center;width:90%}
  h2{color:#22d3ee;margin-bottom:16px}
  .status{margin-top:16px;padding:12px;border-radius:8px;font-weight:600;font-size:14px}
  .loading{background:#1e1b4b;color:#818cf8;border:1px solid #3730a3}
  .success{background:#052e16;color:#4ade80;border:1px solid #166534}
  .error{background:#450a0a;color:#f87171;border:1px solid #991b1b}
  p{color:#a1a1aa;font-size:13px;margin-top:12px}
  .log{margin-top:12px;text-align:left;font-size:11px;color:#71717a;font-family:monospace;max-height:150px;overflow-y:auto;background:#0a0a0a;padding:8px;border-radius:6px}
</style>
</head><body><div class="card">
  <h2>🔑 OA Token Capture</h2>
  <div id="status" class="status loading">⏳ Fetching data from CB Plugin...</div>
  <div id="log" class="log"></div>
  <p id="hint"></p>
</div>
<script>
(async function() {
  const BASE = '${CB_PLUGIN_BASE}';
  const SERVER = 'http://localhost:${PORT}';
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');
  const hintEl = document.getElementById('hint');

  function log(msg) {
    const line = document.createElement('div');
    line.textContent = '> ' + msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  try {
    // Step 1: Check if we have valid cookies by requesting /api/user
    log('Checking login status via /api/user...');
    const userRes = await fetch(BASE + '/api/user', {
      credentials: 'include',
      redirect: 'manual'
    });

    // redirect:manual returns opaqueredirect for 302
    if (userRes.type === 'opaqueredirect' || userRes.status === 0) {
      log('Got redirect - cookie not set or expired');
      statusEl.className = 'status error';
      statusEl.textContent = '❌ OA login did not set cookie properly';
      hintEl.textContent = 'Please try again or use manual paste in dashboard.';
      return;
    }

    if (!userRes.ok) {
      log('User API returned HTTP ' + userRes.status);
      statusEl.className = 'status error';
      statusEl.textContent = '❌ API error: HTTP ' + userRes.status;
      return;
    }

    const userData = await userRes.json();
    log('User: ' + (userData.english_name || userData.name || 'OK'));

    // Step 2: Fetch usage-summary (personal dimension)
    log('Fetching usage summary...');
    const now = new Date();
    const startDate = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-01';
    const endDate = now.toISOString().split('T')[0];
    const platforms = '${CB_PLUGIN_PLATFORMS}';
    const usageUrl = BASE + '/api/usage-summary?start_date=' + startDate + '&end_date=' + endDate + '&dimension=personal&platform=' + encodeURIComponent(platforms);

    let usageSummaryData = null;
    try {
      const usageRes = await fetch(usageUrl, { credentials: 'include' });
      if (usageRes.ok) {
        usageSummaryData = await usageRes.json();
        log('Usage summary: OK');
      } else {
        log('Usage summary: HTTP ' + usageRes.status);
      }
    } catch(e) {
      log('Usage summary error: ' + e.message);
    }

    // Step 3: Fetch query-quota (total remaining percentage)
    log('Fetching quota info...');
    let totalQuotaData = null;
    try {
      const quotaRes = await fetch(BASE + '/api/query-quota?platform=codebuddy', { credentials: 'include' });
      if (quotaRes.ok) {
        totalQuotaData = await quotaRes.json();
        log('Quota: OK (total_usage_rate: ' + (totalQuotaData.total_usage_rate || '?') + '%)');
      } else {
        log('Quota: HTTP ' + quotaRes.status);
      }
    } catch(e) {
      log('Quota error: ' + e.message);
    }

    // Step 4: Fetch platforms list
    log('Fetching platforms...');
    let platformsData = null;
    let categoryQuotas = [];
    try {
      const platRes = await fetch(BASE + '/api/platforms', { credentials: 'include' });
      if (platRes.ok) {
        platformsData = await platRes.json();
        log('Platforms: OK (' + (platformsData.categories ? platformsData.categories.length : 0) + ' categories)');

        // Fetch per-category quota
        if (platformsData.categories && platformsData.categories.length > 0) {
          log('Fetching per-category quotas...');
          const catPromises = platformsData.categories.map(async (cat) => {
            const firstPlatform = (cat.value || '').split(',')[0].trim();
            try {
              const catRes = await fetch(BASE + '/api/query-quota?platform=' + encodeURIComponent(firstPlatform), { credentials: 'include' });
              if (catRes.ok) {
                const catData = await catRes.json();
                return { label: cat.label, value: cat.value, description: cat.description || '', quota: catData };
              }
            } catch(e) {}
            return { label: cat.label, value: cat.value, description: cat.description || '', quota: { _error: 'fetch failed' } };
          });
          categoryQuotas = await Promise.all(catPromises);
          log('Category quotas: ' + categoryQuotas.length + ' fetched');
        }
      } else {
        log('Platforms: HTTP ' + platRes.status);
      }
    } catch(e) {
      log('Platforms error: ' + e.message);
    }

    // Step 5: Fetch quota-allocation (category quota settings)
    log('Fetching quota allocation...');
    let quotaAllocationData = null;
    try {
      const allocRes = await fetch(BASE + '/api/quota-allocation', { credentials: 'include' });
      if (allocRes.ok) {
        quotaAllocationData = await allocRes.json();
        log('Quota allocation: OK (' + (quotaAllocationData.data && quotaAllocationData.data.items ? quotaAllocationData.data.items.length : 0) + ' items)');
      } else {
        log('Quota allocation: HTTP ' + allocRes.status);
      }
    } catch(e) {
      log('Quota allocation error: ' + e.message);
    }

    // Step 6: Send data to our server
    log('Sending data to dashboard server...');
    const payload = {
      user: userData,
      usageSummary: usageSummaryData,
      totalQuota: totalQuotaData,
      platforms: platformsData,
      categoryQuotas: categoryQuotas,
      quotaAllocation: quotaAllocationData,
      timestamp: Date.now()
    };

    const saveRes = await fetch(SERVER + '/api/cb-plugin-browser-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const saveResult = await saveRes.json();

    if (saveResult.success) {
      log('Data saved successfully!');
      statusEl.className = 'status success';
      statusEl.textContent = '✅ OA login successful! Data captured.';
      hintEl.textContent = 'This window will close automatically...';
      setTimeout(function() { window.close(); }, 2000);
    } else {
      log('Save failed: ' + (saveResult.error || 'unknown'));
      statusEl.className = 'status error';
      statusEl.textContent = '❌ Failed to save data';
    }
  } catch(e) {
    log('Error: ' + e.message);
    statusEl.className = 'status error';
    statusEl.textContent = '❌ ' + e.message;
    hintEl.textContent = 'Please try manual paste in dashboard.';
  }
})();
</script></body></html>`;
}

// Generate the CB IDE capture page - guides user to auto-capture cookie and data from CB IDE site
function generateCBIDECapturePageHTML() {
  // This script will be run on the CB IDE domain (tencent.sso.codebuddy.cn)
  // It captures cookie + billing data and sends to our server
  const captureScript = `(async function(){
  const SERVER='http://localhost:${PORT}';
  const BASE='https://tencent.sso.codebuddy.cn';
  const now=new Date();
  const productCode='${CB_IDE_PRODUCT_CODE}';
  let enterpriseUsageData=null,resourceData=null;
  try{
    const r=await fetch(BASE+'/billing/meter/get-enterprise-user-usage',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:'{}'});
    if(r.ok)enterpriseUsageData=await r.json();
  }catch(e){console.log('Enterprise usage error:',e)}
  try{
    const r=await fetch(BASE+'/billing/meter/get-user-resource',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({PageNumber:1,PageSize:200,ProductCode:productCode,Status:[0,3],PackageEndTimeRangeBegin:now.toISOString().replace('T',' ').substring(0,19),PackageEndTimeRangeEnd:new Date(now.getTime()+101*365*24*60*60*1000).toISOString().replace('T',' ').substring(0,19)})});
    if(r.ok)resourceData=await r.json();
  }catch(e){console.log('Resource error:',e)}
  const payload={cookie:document.cookie,billingData:{enterpriseUsage:enterpriseUsageData,resource:resourceData,timestamp:Date.now()}};
  const res=await fetch(SERVER+'/api/cb-ide-cookie-capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const result=await res.json();
  if(result.success){alert('✅ CB IDE data captured successfully! You can close this tab.');window.close();}
  else{alert('❌ Failed: '+(result.error||'unknown'));}
})();`;

  const minifiedScript = captureScript.replace(/\n/g, '');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>CB IDE Auto Capture</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#fafafa;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .card{background:#171717;border:1px solid #27272a;border-radius:12px;padding:32px;max-width:560px;text-align:center;width:90%}
  h2{color:#22d3ee;margin-bottom:8px;font-size:20px}
  .subtitle{color:#a1a1aa;font-size:13px;margin-bottom:20px}
  .step{text-align:left;margin:12px 0;padding:14px;background:#0a0a0a;border-radius:8px;border:1px solid #27272a}
  .step-num{display:inline-block;width:24px;height:24px;background:#22d3ee;color:#0a0a0a;border-radius:50%;text-align:center;line-height:24px;font-weight:700;font-size:12px;margin-right:8px;vertical-align:middle}
  .step-text{color:#e4e4e7;font-size:13px;vertical-align:middle}
  .btn{display:inline-block;margin:6px 4px;padding:10px 20px;border:none;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;text-decoration:none;transition:all 0.2s}
  .btn-primary{background:linear-gradient(135deg,#22d3ee,#06b6d4);color:#0a0a0a}
  .btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(34,211,238,0.3)}
  .btn-secondary{background:#262626;color:#e4e4e7;border:1px solid #3f3f46}
  .btn-secondary:hover{background:#2d2d2d}
  .bookmarklet{display:inline-block;padding:10px 20px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#0a0a0a;border-radius:8px;font-weight:700;font-size:13px;cursor:grab;text-decoration:none;margin:8px 0;border:2px dashed #f59e0b}
  .bookmarklet:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(245,158,11,0.3)}
  .divider{border-top:1px solid #27272a;margin:16px 0;position:relative}
  .divider-text{position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:#171717;padding:0 12px;color:#71717a;font-size:11px}
  .status{margin-top:12px;padding:10px;border-radius:8px;font-size:13px;display:none}
  .status.show{display:block}
  .success{background:#052e16;color:#4ade80;border:1px solid #166534}
  .waiting{background:#1e1b4b;color:#818cf8;border:1px solid #3730a3}
  kbd{background:#262626;padding:1px 5px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;font-family:monospace}
  .method-label{color:#f59e0b;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
</style>
</head><body><div class="card">
  <h2>🔑 CB IDE Auto Capture</h2>
  <p class="subtitle">Automatically capture cookie & billing data from CodeBuddy IDE</p>

  <div id="statusBox" class="status waiting show">⏳ Waiting for data capture...</div>

  <div class="step">
    <div class="method-label">⚡ Method 1: Bookmarklet (Recommended)</div>
    <div style="margin:8px 0">
      <span class="step-num">1</span>
      <span class="step-text">Drag this button to your <b>bookmarks bar</b>:</span>
    </div>
    <div style="text-align:center;margin:10px 0">
      <a class="bookmarklet" href="javascript:${encodeURIComponent(minifiedScript)}" onclick="event.preventDefault();alert('Drag this to your bookmarks bar, then click it on the CB IDE site!')">📦 CB IDE Capture</a>
    </div>
    <div style="margin:8px 0">
      <span class="step-num">2</span>
      <span class="step-text">Open <a href="https://tencent.sso.codebuddy.cn/profile/" target="_blank" style="color:#22d3ee">CB IDE Profile</a> (make sure you're logged in)</span>
    </div>
    <div style="margin:8px 0">
      <span class="step-num">3</span>
      <span class="step-text">Click the <b>"📦 CB IDE Capture"</b> bookmark</span>
    </div>
  </div>

  <div class="divider"><span class="divider-text">OR</span></div>

  <div class="step">
    <div class="method-label">🔧 Method 2: Console Script</div>
    <div style="margin:8px 0">
      <span class="step-num">1</span>
      <span class="step-text">Open <a href="https://tencent.sso.codebuddy.cn/profile/" target="_blank" style="color:#22d3ee">CB IDE Profile</a> and make sure you're logged in</span>
    </div>
    <div style="margin:8px 0">
      <span class="step-num">2</span>
      <span class="step-text">Press <kbd>F12</kbd> → <b>Console</b> tab</span>
    </div>
    <div style="margin:8px 0">
      <span class="step-num">3</span>
      <span class="step-text">Click the button below to copy the script, then paste in Console:</span>
    </div>
    <div style="text-align:center;margin:8px 0">
      <button class="btn btn-primary" id="copyBtn" onclick="copyScript()">📋 Copy Capture Script</button>
    </div>
  </div>

  <div style="margin-top:16px">
    <button class="btn btn-secondary" onclick="window.close()">Close</button>
  </div>
</div>
<script>
  const captureScript = ${JSON.stringify(minifiedScript)};

  function copyScript() {
    navigator.clipboard.writeText(captureScript).then(() => {
      const btn = document.getElementById('copyBtn');
      btn.textContent = '✅ Copied! Now paste in CB IDE Console';
      btn.style.background = 'linear-gradient(135deg,#4ade80,#22c55e)';
      setTimeout(() => {
        btn.textContent = '📋 Copy Capture Script';
        btn.style.background = '';
      }, 3000);
    });
  }

  // Poll server to check if capture was successful
  let pollCount = 0;
  const pollInterval = setInterval(async () => {
    pollCount++;
    try {
      const res = await fetch('/api/oa-status-ide');
      const data = await res.json();
      if (data.status === 'valid') {
        clearInterval(pollInterval);
        const statusBox = document.getElementById('statusBox');
        statusBox.className = 'status success show';
        statusBox.textContent = '✅ CB IDE data captured successfully! This window will close...';
        setTimeout(() => window.close(), 2000);
      }
    } catch(e) {}
    if (pollCount >= 120) clearInterval(pollInterval); // Stop after 6 min
  }, 3000);
</script></body></html>`;
}

// ===== Custom URL proxy for API discovery =====
async function proxyRequest(targetUrl, cookie) {
  try {
    const res = await httpsRequest(targetUrl, {
      headers: {
        'Cookie': cookie || '',
        'Accept': 'application/json, text/html, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    return { status: res.status, headers: res.headers, body: res.body.substring(0, 10000) };
  } catch (e) {
    return { error: e.message };
  }
}

// ===== HTTP Server =====
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Serve the dashboard HTML
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'quota-dashboard.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf-8'));
    } else {
      res.writeHead(404);
      res.end('quota-dashboard.html not found');
    }
    return;
  }

  // API: Fetch all usage data
  if (pathname === '/api/usage') {
    console.log('\n[API] Fetching all usage data...');
    const env = loadEnv();
    const [cursor, cbPlugin, cbIDE] = await Promise.all([
      fetchCursorUsage(env),
      fetchCodeBuddyPluginUsage(env),
      fetchCodeBuddyIDEUsage(env),
    ]);

    const result = {
      timestamp: new Date().toISOString(),
      cursor,
      codebuddyPlugin: cbPlugin,
      codebuddyIDE: cbIDE,
    };

    console.log('[API] Results:', JSON.stringify({
      cursor: cursor.success ? 'OK' : cursor.error,
      cbPlugin: cbPlugin.success ? 'OK' : cbPlugin.error,
      cbIDE: cbIDE.success ? 'OK' : cbIDE.error,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // API: Fetch individual platform
  if (pathname === '/api/cursor') {
    const env = loadEnv();
    const data = await fetchCursorUsage(env);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  if (pathname === '/api/codebuddy-plugin') {
    const env = loadEnv();
    const data = await fetchCodeBuddyPluginUsage(env);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  if (pathname === '/api/codebuddy-ide') {
    const env = loadEnv();
    const data = await fetchCodeBuddyIDEUsage(env);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  // API: Proxy a custom URL (for API discovery)
  if (pathname === '/api/probe') {
    const targetUrl = url.searchParams.get('url');
    const platform = url.searchParams.get('platform');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
      return;
    }
    const env = loadEnv();
    let cookie = url.searchParams.get('cookie') || '';
    if (platform === 'cursor') cookie = env.CURSOR_COOKIE || cookie;
    else if (platform === 'codebuddy-plugin') cookie = env.CODEBUDDY_PLUGIN_COOKIE || cookie;
    else if (platform === 'codebuddy-ide') cookie = env.CODEBUDDY_IDE_COOKIE || cookie;

    console.log(`[Probe] ${targetUrl}`);
    const data = await proxyRequest(targetUrl, cookie);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  // API: OA Login - redirect to OA login page for CB Plugin
  // Popup opens this -> OA login -> _auth_login sets cookie -> lands on tokens-site
  // Then dashboard uses CORS fetch to grab data from tokens-site via browser cookies
  if (pathname === '/oa-login') {
    console.log('[OA Login] Initiating OA login flow...');
    const result = await getOALoginUrl();
    if (result.success) {
      // Don't modify callback URL - let _auth_login work normally
      // After login, popup lands on tokens-site with valid cookies
      // Dashboard will use CORS fetch to grab data
      console.log('[OA Login] Redirecting to:', result.loginUrl.substring(0, 120) + '...');
      res.writeHead(302, { 'Location': result.loginUrl });
      res.end();
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get OA login URL', detail: result.error }));
    }
    return;
  }

  // API: Receive CB Plugin data from browser (sent by /oa-capture page)
  if (pathname === '/api/cb-plugin-browser-data' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        cbPluginBrowserCache = data;
        cbPluginBrowserCacheTime = Date.now();
        console.log('[OA Capture] Received browser data - user:', data.user?.english_name || data.user?.name || 'unknown');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Debug: dump browser cache data structure
  if (pathname === '/api/debug-cb-cache') {
    if (!cbPluginBrowserCache) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'No browser cache available' }));
      return;
    }
    const usage = cbPluginBrowserCache.usageSummary;
    const items = usage && Array.isArray(usage.data) ? usage.data : (Array.isArray(usage) ? usage : []);
    const platforms = cbPluginBrowserCache.platforms;
    const allocation = cbPluginBrowserCache.quotaAllocation;
    const catQuotas = cbPluginBrowserCache.categoryQuotas || [];
    const debug = {
      usageSummary_itemCount: items.length,
      usageSummary_firstItemKeys: items.length > 0 ? Object.keys(items[0]) : [],
      usageSummary_first5: items.slice(0, 5),
      usageSummary_allPlatforms: [...new Set(items.map(i => i.platform || 'NONE'))],
      usageSummary_allTypes: [...new Set(items.map(i => i.type || 'NONE'))],
      platforms_categories: platforms && platforms.categories ? platforms.categories.map(c => ({ label: c.label, value: c.value })) : 'N/A',
      allocation_items: allocation && allocation.data && allocation.data.items ? allocation.data.items.map(a => ({ label: a.label, product_group: a.product_group, quota_disabled: a.quota_disabled, total_cost: a.total_cost })) : 'N/A',
      categoryQuotas: catQuotas.map(c => ({ label: c.label, value: c.value })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(debug, null, 2));
    return;
  }

  // API: Receive CB IDE data from browser (sent by CORS capture)
  if (pathname === '/api/cb-ide-browser-data' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!isCBIDECacheValid(data)) {
          console.log('[CB IDE Capture] Received browser data but enterpriseUsage and resource are both null - rejecting');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No valid data received. Make sure you run the script on the CB IDE site (tencent.sso.codebuddy.cn) while logged in.' }));
          return;
        }
        persistCBIDECache(data);
        console.log('[CB IDE Capture] Received browser data and persisted');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: OA Login for CB IDE - redirect to OA login page
  if (pathname === '/oa-login-ide') {
    console.log('[OA Login IDE] Initiating OA login flow for CB IDE...');
    // Redirect to CB IDE profile page - it will redirect to OA login if needed
    res.writeHead(302, { 'Location': `${CB_IDE_BASE}/profile/` });
    res.end();
    return;
  }

  // CB IDE OA Capture page - runs a script on CB IDE domain to grab data
  if (pathname === '/oa-capture-ide') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateCBIDECapturePageHTML());
    return;
  }

  // CB IDE capture callback - receives cookie from the capture script running on CB IDE domain
  if (pathname === '/api/cb-ide-cookie-capture' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const cookie = data.cookie;
        if (!cookie) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No cookie provided' }));
          return;
        }

        // Save cookie to .env
        const env = loadEnv();
        env.CODEBUDDY_IDE_COOKIE = cookie;
  const envPath = path.join(__dirname, '.env.quota');
        const lines = [
          '# Quota Dashboard Configuration',
          '# Paste WorkosCursorSessionToken value or full cookie from cursor.com',
          '',
          '# Cursor (WorkosCursorSessionToken from cursor.com)',
          `CURSOR_COOKIE=${env.CURSOR_COOKIE || ''}`,
          '# Tip: Only WorkosCursorSessionToken is needed, valid ~50 days',
          '',
          '# CodeBuddy Plugin (from tokens-nbyxw43y.app.with.woa.com)',
          `CODEBUDDY_PLUGIN_COOKIE=${env.CODEBUDDY_PLUGIN_COOKIE || ''}`,
          '',
          '# CodeBuddy IDE (from tencent.sso.codebuddy.cn)',
          `CODEBUDDY_IDE_COOKIE=${cookie}`,
          '# Auto-fetches from /billing/meter/get-user-resource and /billing/meter/get-user-request-usage',
          '',
        ];
        fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
        console.log('[CB IDE Cookie Capture] Cookie saved to .env, length:', cookie.length);

        // Also cache the browser data if provided (persisted to file)
        if (data.billingData) {
          persistCBIDECache(data.billingData);
          console.log('[CB IDE Cookie Capture] Browser data cached and persisted');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: OA Login status check - verify if CB Plugin cookie is valid or browser cache available
  if (pathname === '/api/oa-status') {
    // Check browser cache first (set by /oa-capture page)
    if (cbPluginBrowserCache && (Date.now() - cbPluginBrowserCacheTime) < CB_PLUGIN_CACHE_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'valid', message: 'Browser cache available', source: 'browser_cache' }));
      return;
    }

    const env = loadEnv();
    const cookie = env.CODEBUDDY_PLUGIN_COOKIE;
    if (!cookie) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'no_cookie', message: 'No cookie configured' }));
      return;
    }
    // Quick check: try /api/user without following redirects
    try {
      const checkRes = await httpsRequest(`${CB_PLUGIN_BASE}/api/user`, {
        headers: { 'Cookie': cookie, 'Accept': 'application/json' },
      }, 0);
      if (checkRes.redirected) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'expired', message: 'Cookie expired - needs OA login' }));
      } else if (checkRes.status === 200) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'valid', message: 'Cookie is valid' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: `HTTP ${checkRes.status}` }));
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: e.message }));
    }
    return;
  }

  // API: OA Login status check for CB IDE - verify if cookie is valid or browser cache available
  if (pathname === '/api/oa-status-ide') {
    // Check browser cache first - must have valid data (not null)
    if (cbIDEBrowserCache && isCBIDECacheValid(cbIDEBrowserCache) && (Date.now() - cbIDEBrowserCacheTime) < CB_IDE_CACHE_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'valid', message: 'Browser cache available', source: 'browser_cache' }));
      return;
    }

    const env = loadEnv();
    const cookie = env.CODEBUDDY_IDE_COOKIE;
    if (!cookie) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'no_cookie', message: 'No cookie configured' }));
      return;
    }
    // Quick check: try /console/accounts without following redirects
    try {
      const checkRes = await httpsRequest(`${CB_IDE_BASE}/console/accounts`, {
        headers: { 'Cookie': cookie, 'Accept': 'application/json' },
      }, 0);
      if (checkRes.redirected) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'expired', message: 'Cookie expired - needs OA login' }));
      } else if (checkRes.status === 200) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'valid', message: 'Cookie is valid' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: `HTTP ${checkRes.status}` }));
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: e.message }));
    }
    return;
  }

  // API: Check .env config status
  if (pathname === '/api/config-status') {
    const env = loadEnv();
    const cursorTokenStatus = env.CURSOR_COOKIE ? checkCursorTokenExpiry(env.CURSOR_COOKIE) : null;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      cursor: !!env.CURSOR_COOKIE,
      cursorTokenStatus,
      codebuddyPlugin: !!env.CODEBUDDY_PLUGIN_COOKIE,
      codebuddyIDE: !!env.CODEBUDDY_IDE_COOKIE,
    }));
    return;
  }

  // API: Update .env config
  if (pathname === '/api/update-config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const env = loadEnv();
        Object.assign(env, updates);

  const envPath = path.join(__dirname, '.env.quota');
        const lines = [
          '# Quota Dashboard Configuration',
          '# Paste WorkosCursorSessionToken value or full cookie from cursor.com',
          '',
          '# Cursor (WorkosCursorSessionToken from cursor.com)',
          `CURSOR_COOKIE=${env.CURSOR_COOKIE || ''}`,
          '# Tip: Only WorkosCursorSessionToken is needed, valid ~50 days',
          '',
          '# CodeBuddy Plugin (from tokens-nbyxw43y.app.with.woa.com)',
          `CODEBUDDY_PLUGIN_COOKIE=${env.CODEBUDDY_PLUGIN_COOKIE || ''}`,
          '',
          '# CodeBuddy IDE (from tencent.sso.codebuddy.cn)',
          `CODEBUDDY_IDE_COOKIE=${env.CODEBUDDY_IDE_COOKIE || ''}`,
          '# Auto-fetches from /billing/meter/get-user-resource and /billing/meter/get-user-request-usage',
          '',
        ];
        fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Auto-detect available port and start server
function startServer(port) {
  PORT = port;
  server.listen(port, () => {
    // Write actual port to .port file so other tools can discover it
    const portFile = path.join(__dirname, '.port.quota');
    fs.writeFileSync(portFile, String(port), 'utf-8');

    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║     📊 Quota Dashboard Server Started        ║');
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log(`  ║  🌐 Dashboard:  http://localhost:${port}          ║`);
    console.log(`  ║  📡 API:        http://localhost:${port}/api/usage ║`);
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log('  ║  Configure cookies & API URLs in .env or UI  ║');
    console.log('  ║  Use F12 > Network to find API endpoints     ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    if (port !== DEFAULT_PORT) {
      console.log(`  ⚠️  Port ${DEFAULT_PORT} was in use, using ${port} instead`);
    }
    console.log('');

    // Auto-open browser if --open flag is set
    if (AUTO_OPEN_BROWSER) {
      const url = `http://localhost:${port}`;
      const cmd = process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"`
        : `xdg-open "${url}"`;
      exec(cmd, (err) => {
        if (err) console.log('  ⚠️  Could not auto-open browser:', err.message);
      });
    }
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const nextPort = PORT + 1;
    if (nextPort < DEFAULT_PORT + MAX_PORT_ATTEMPTS) {
      console.log(`  ⚠️  Port ${PORT} is in use, trying ${nextPort}...`);
      server.close();
      startServer(nextPort);
    } else {
      console.error(`  ❌ All ports ${DEFAULT_PORT}-${PORT} are in use. Please free a port and try again.`);
      process.exit(1);
    }
  } else {
    console.error('  ❌ Server error:', err.message);
    process.exit(1);
  }
});

startServer(DEFAULT_PORT);

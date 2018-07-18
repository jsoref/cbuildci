'use strict';

const url = require('url');
const jwt = require('jsonwebtoken');
const { request } = require('./request');

exports.parseGitHubUrl = function parseGitHubUrl(githubUrl) {
    const parsed = url.parse(githubUrl);
    return {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        pathname: (parsed.pathname || '/').replace(/^\/$/, ''),
    };
};

exports.isTokenExpired = function isTokenExpired(expiresAt, bufferMS = 15000) {
    expiresAt = new Date(expiresAt);

    // Take off the specified amount of time off of token expiration to
    // buffer for differences in the time.
    expiresAt.setTime(expiresAt.getTime() - bufferMS);

    return expiresAt.getTime() <= Date.now();
};

exports.pruneTokenCache = function pruneTokenCache(cache) {
    for (const [key, value] of Object.entries(cache)) {
        if (!exports.isTokenExpired(value.expires_at, 0)) {
            delete cache[key];
        }
    }
};

exports.getInstallationAccessToken = async function getInstallationAccessToken(
    githubAppId,
    githubApiUrl,
    appPrivateKey,
    installationId,
    cache = null,
) {
    const parsedUrl = exports.parseGitHubUrl(githubApiUrl);
    const cached = cache && cache[`${parsedUrl.hostname}/${installationId}`];

    if (cached) {
        // Reuse the token if it is still valid.
        if (!exports.isTokenExpired(cached.expires_at)) {
            return cached;
        }
        else {
            // Otherwise delete the cached token and get a new one.
            delete cache[`${parsedUrl.hostname}/${installationId}`];
        }
    }

    const jwt = createJWT(
        githubAppId,
        typeof appPrivateKey === 'function'
            ? await appPrivateKey()
            : appPrivateKey
    );

    const headers = {
        Accept: 'application/vnd.github.machine-man-preview+json',
        Authorization: `Bearer ${jwt}`,
        'User-Agent': 'CBuildCI https://github.com/cbuildci/cbuildci',
    };

    const urlOpts = {
        ...parsedUrl,
        pathname: `${parsedUrl.pathname}/installations/${installationId}/access_tokens`,
    };

    const response = await request(
        'POST',
        url.format(urlOpts),
        null,
        {
            headers,
        },
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
        let responseBody;

        try {
            responseBody = Buffer.isBuffer(response.data)
                ? response.data.toString('utf8')
                : JSON.stringify(response.data, null, 2);
        }
        catch (err) {
            responseBody = '';
        }

        throw new Error(`Failed to get installation access token (code:${response.statusCode})${responseBody ? `\n${responseBody}` : ''}`);
    }

    if (!response.data || !response.data.token) {
        throw new Error(`Failed to get installation access token (${response.data ? 'missing token' : 'no JSON data'})`);
    }

    if (cache) {
        cache[`${parsedUrl.hostname}/${installationId}`] = response.data;
    }

    return response.data;
};

exports.getRepository = async function getRepository(
    githubApiUrl,
    token,
    owner,
    repo,
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/repos/${owner}/${repo}`,
    );
};

exports.getPullRequest = async function getPullRequest(
    githubApiUrl,
    token,
    owner,
    repo,
    number,
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/repos/${owner}/${repo}/pulls/${number}`,
    );
};

exports.getPullRequestCommits = async function getPullRequestCommits(
    githubApiUrl,
    token,
    owner,
    repo,
    number,
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/repos/${owner}/${repo}/pulls/${number}/commits`,
    );
};

exports.getFileContent = async function getFileContent(
    githubApiUrl,
    token,
    owner,
    repo,
    sha,
    path,
    {
        maxSize = null,
    } = {}
) {
    const response = await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/repos/${owner}/${repo}/contents/${path}`,
        {
            query: {
                ref: sha,
            },
        },
    );

    if (response.statusCode === 200) {
        if (Array.isArray(response.data)) {
            throw new Error('Path is directory');
        }

        if (response.data.type !== 'file') {
            throw new Error(`Not a file: ${response.data.type}`);
        }

        if (maxSize && isFinite(maxSize) && response.data.size > maxSize) {
            throw new Error(`File cannot be larger than ${maxSize} bytes: ${response.data.size}`);
        }

        return response.data.encoding === 'base64'
            ? Buffer.from(response.data.content, 'base64').toString('utf8')
            : response.data.content;
    }
    else {
        let responseBody;

        try {
            responseBody = Buffer.isBuffer(response.data)
                ? response.data.toString('utf8')
                : JSON.stringify(response.data, null, 2);
        }
        catch (err) {
            responseBody = '';
        }

        throw new Error(`Did not return 200: ${response.statusCode}${responseBody ? `\n${responseBody}` : ''}`);
    }
};

exports.getDownloadURL = async function getDownloadURL(
    githubApiUrl,
    token,
    owner,
    repo,
    sha,
    type,
) {
    const response = await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/repos/${owner}/${repo}/${type || 'tarball'}/${sha}`,
    );

    if (response.statusCode === 302) {
        return response.headers.location;
    }
    else {
        throw new Error(`Did not return 302 redirect: ${response.statusCode}`);
    }
};

exports.downloadArchive = async function downloadArchive(
    githubApiUrl,
    token,
    owner,
    repo,
    sha,
    type,
    writeStream,
) {
    const downloadURL = await exports.getDownloadURL(
        githubApiUrl,
        token,
        owner,
        repo,
        sha,
        type,
    );

    return await request(
        'GET',
        downloadURL,
        null,
        {
            writeStream,
        },
    );
};

exports.listStatus = async function listStatus(
    githubApiUrl,
    token,
    owner,
    repo,
    sha,
    context,
) {
    const response = await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/repos/${owner}/${repo}/commits/${sha}/statuses`,
    );

    if (!response.data || !Array.isArray(response.data) || !response.data.length) {
        return null;
    }

    const statuses = response.data.filter((status) => status.context === context);
    return statuses.length ? statuses[0] : null;
};

exports.pushCommitStatus = async function pushCommitStatus(
    githubApiUrl,
    token,
    owner,
    repo,
    sha,
    state,
    context,
    description,
    targetUrl,
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'POST',
        `/repos/${owner}/${repo}/statuses/${sha}`,
        {
            data: {
                state,
                target_url: targetUrl,
                context,
                description: trimToLength(description, 140, true),
            },
        },
    );
};

exports.getIssue = async function getIssue(githubApiUrl, token, owner, repo, number) {
    return await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/repos/${owner}/${repo}/issues/${number}`,
    );
};

exports.createCheckRun = async function createCheckRun(
    githubApiUrl,
    token,
    owner,
    repo,
    name,
    head_sha,
    {
        details_url,
        external_id,
        status,
        started_at,
        conclusion,
        completed_at,
        output,
        actions,
    },
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'POST',
        `/repos/${owner}/${repo}/check-runs`,
        {
            acceptBase: 'application/vnd.github.antiope-preview',
            data: {
                name,
                head_sha,
                details_url,
                external_id,
                status,
                started_at: started_at && new Date(started_at).toISOString(),
                conclusion,
                completed_at: completed_at && new Date(completed_at).toISOString(),
                output,
                actions,
            },
        },
    );
};

exports.updateCheckRun = async function updateCheckRun(
    githubApiUrl,
    token,
    owner,
    repo,
    checkRunId,
    name,
    {
        details_url,
        external_id,
        status,
        started_at,
        conclusion,
        completed_at,
        output,
        actions,
    },
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'PATCH',
        `/repos/${owner}/${repo}/check-runs/${checkRunId}`,
        {
            acceptBase: 'application/vnd.github.antiope-preview',
            data: {
                name,
                details_url,
                external_id,
                status,
                started_at: started_at && new Date(started_at).toISOString(),
                conclusion,
                completed_at: completed_at && new Date(completed_at).toISOString(),
                output,
                actions,
            },
        },
    );
};

exports.getUser = async function getUser(
    githubApiUrl,
    token,
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'GET',
        '/user',
    );
};

exports.getUserInstallationsAccessible = async function getUserInstallationsAccessible(
    githubApiUrl,
    token,
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'GET',
        '/user/installations',
    );
};

exports.getUserReposAccessibleForInstallation = async function getUserReposAccessibleForInstallation(
    githubApiUrl,
    token,
    installationId,
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/user/installations/${installationId}/repositories`,
    );
};

exports.getOrgTeams = async function getOrgTeams(
    githubApiUrl,
    token,
    org,
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/orgs/${org}/teams`,
    );
};

exports.getTeamMembership = async function getTeamMembership(
    githubApiUrl,
    token,
    teamId,
    username,
) {
    return await apiRequest(
        githubApiUrl,
        token,
        'GET',
        `/teams/${teamId}/memberships/${username}`,
    );
};

function trimToLength(str, maxLength, useEllipsis) {
    return str.length > maxLength
        ? useEllipsis
            ? str.substr(0, maxLength - 3) + '...'
            : str.substr(0, maxLength)
        : str;
}

function createJWT(appId, privateKey, expirationMinutes = 10) {
    return jwt.sign({
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expirationMinutes * 60,
        iss: appId,
    }, privateKey, { algorithm: 'RS256' });
}

exports.apiRequest = apiRequest;
async function apiRequest(
    githubApiUrl,
    token,
    method,
    path,
    { query = null, data = null, writeStream = null, raw = false, acceptBase = null } = {}
) {
    const parsedUrl = exports.parseGitHubUrl(githubApiUrl);

    let Accept = acceptBase || 'application/vnd.github.machine-man-preview';

    if (raw) {
        Accept += '.raw';
    }
    else {
        Accept += '+json';
    }

    const headers = {
        Accept,
        Authorization: `token ${token}`,
        'User-Agent': 'CBuildCI https://github.com/cbuildci/cbuildci',
    };

    const urlOpts = {
        ...parsedUrl,
        pathname: `${parsedUrl.pathname}${path}`,
    };

    if (query) {
        urlOpts.query = query;
    }

    if (data) {
        if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
            throw new Error(`Option 'data' not allowed for ${method}`);
        }
        else {
            data = JSON.stringify(data);
            headers['Content-Type'] = 'application/json;charset=UTF-8';
            headers['Content-Length'] = Buffer.byteLength(data);
        }
    }

    return await request(
        method,
        url.format(urlOpts),
        data,
        {
            headers,
            raw,
            writeStream,
        },
    );
}
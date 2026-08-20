const https = require('https');
const config = require('../config');

class AuthService {
    constructor() {
        this.accessToken = null;
        this.tokenExpiry = null;
        this.refreshToken = config.refreshToken;
        this.clientId = 'trade-api-write';
        this._tokenReceived = false;
        this._lastRefreshAttempt = null;
        this._refreshCount = 0;
        this._errors = [];
    }

    async getAccessToken() {
        if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }
        if (this.accessToken && this._tokenReceived) {
            return this.accessToken;
        }
        console.log('[Auth] 🔄 Fetching new token...');
        const result = await this.fetchToken();
        this.accessToken = result.access_token;
        const expiresIn = result.expires_in || 86400;
        this.tokenExpiry = Date.now() + (expiresIn * 1000);
        this._tokenReceived = true;
        this._lastRefreshAttempt = new Date();
        this._refreshCount++;
        console.log(`[Auth] ✅ Token received, expires in ${expiresIn}s`);
        return this.accessToken;
    }

    fetchToken() {
        return new Promise((resolve, reject) => {
            const postData = `client_id=${this.clientId}&grant_type=refresh_token&refresh_token=${this.refreshToken}`;
            const options = {
                hostname: new URL(config.baseUrl).hostname,
                path: '/trade-api-keycloak/realms/tradeapi/protocol/openid-connect/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error) {
                            reject(new Error(`Auth error: ${json.error}`));
                            return;
                        }
                        if (!json.access_token) {
                            reject(new Error('No access_token in response'));
                            return;
                        }
                        resolve({
                            access_token: json.access_token,
                            expires_in: json.expires_in || 86400,
                            refresh_token: json.refresh_token,
                            token_type: json.token_type || 'Bearer'
                        });
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${e.message}`));
                    }
                });
            });
            req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
            req.write(postData);
            req.end();
        });
    }

    isTokenValid() {
        if (this.accessToken) {
            if (this.tokenExpiry) return Date.now() < (this.tokenExpiry - 300000);
            return this._tokenReceived;
        }
        return false;
    }

    getTimeUntilExpiry() {
        if (!this.tokenExpiry) return 86400;
        return Math.max(0, (this.tokenExpiry - Date.now()) / 1000);
    }

    getStats() {
        return {
            hasToken: !!this.accessToken,
            isTokenValid: this.isTokenValid(),
            expiresIn: this.getTimeUntilExpiry(),
            expiresInHours: (this.getTimeUntilExpiry() / 3600).toFixed(1),
            refreshCount: this._refreshCount,
            lastRefreshAttempt: this._lastRefreshAttempt ? this._lastRefreshAttempt.toISOString() : null,
            errors: this._errors.slice(-5),
            tokenPreview: this.accessToken ? this.accessToken.substring(0, 20) + '...' : null,
        };
    }
}

module.exports = new AuthService();

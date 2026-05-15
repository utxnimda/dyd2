    # 由 fmz-dashboard.conf / nginx-fmz-dashboard.conf 的 :80 / :443 server 块 include。

    resolver 119.29.29.29 8.8.8.8 valid=300s ipv6=off;

    root /var/www/fmz-dashboard;
    index index.html;

    set $fmz_upstream_browser_origin "https://fmz.dongdongne.com";

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /__fmz_api/ {
        set $fmz_api_upstream api2.dongdongne.com;
        proxy_pass https://$fmz_api_upstream/;
        proxy_ssl_server_name on;
        proxy_set_header Host api2.dongdongne.com;
        proxy_set_header Origin $fmz_upstream_browser_origin;
        proxy_set_header Referer "$fmz_upstream_browser_origin/";
        proxy_set_header Sec-Fetch-Site "same-site";
        proxy_set_header Sec-Fetch-Mode "cors";
        proxy_set_header Sec-Fetch-Dest "empty";
        proxy_set_header Sec-Fetch-User "";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
    }

    location /__fmz_defense/ {
        proxy_pass http://127.0.0.1:8788/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /__fmz_reactions/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /doseeing/ {
        proxy_pass https://www.doseeing.com/;
        proxy_ssl_server_name on;
        proxy_set_header Host www.doseeing.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /__fmz_audio/ {
        proxy_pass http://127.0.0.1:8789/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        client_max_body_size 200m;
    }

    location /__bili_api/ {
        proxy_pass https://api.bilibili.com/;
        proxy_ssl_server_name on;
        proxy_set_header Host api.bilibili.com;
        proxy_set_header Referer "https://www.bilibili.com/";
        proxy_set_header Origin "https://www.bilibili.com";
        proxy_set_header User-Agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
        proxy_set_header X-Real-IP $remote_addr;

        set $bili_buvid3 $http_x_bili_buvid3;
        proxy_set_header Cookie "buvid3=$bili_buvid3";
        proxy_hide_header X-Bili-Buvid3;
    }

    location /__fmz_danmaku/ {
        proxy_pass http://127.0.0.1:8791/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE support: disable buffering and set long timeouts
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        chunked_transfer_encoding on;
    }

    location /__fmz_crimes/ {
        proxy_pass http://127.0.0.1:8790/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /__douyu_api/ {
        proxy_pass https://v.douyu.com/;
        proxy_ssl_server_name on;
        proxy_set_header Host v.douyu.com;
        proxy_set_header Referer "https://v.douyu.com/";
        proxy_set_header Origin "https://v.douyu.com";
        proxy_set_header User-Agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
        proxy_set_header X-Real-IP $remote_addr;
    }

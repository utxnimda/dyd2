#!/usr/bin/env bash
# 腾讯云 CVM：支持 Debian/Ubuntu（apt）与 TencentOS / RHEL 系（dnf/yum），安装 Nginx、自签证书、启用站点。
# SSH 与上传示例见同目录：连接服务器与部署步骤.txt
#
# TencentOS Server 3.x（TK4）为 RHEL 系：使用 dnf、配置写在 /etc/nginx/conf.d/
#
# 事前准备：
#   1. 安全组入站：22、80、443
#   2. Let’s Encrypt 需域名 A 记录指向本机公网 IP
#
# 用法：
#   sudo bash tencent-cloud-setup.sh [--build] <域名或公网IP>
#
# 仅上传静态文件（本机 npm run build 后）：
#   scp -r dist/* root@服务器IP:/var/www/fmz-dashboard/
#   sudo bash tencent-cloud-setup.sh 你的域名或公网IP

set -euo pipefail

BUILD_ON_SERVER=0
DOMAIN=""

usage() {
  echo "用法: sudo $0 [--build] <域名或公网IP>" >&2
  echo "示例: sudo $0 dashboard.example.com" >&2
  echo "      sudo $0 --build $(hostname -I 2>/dev/null | awk '{print $1}' || echo 1.2.3.4)" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD_ON_SERVER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) DOMAIN="$1"; shift ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  usage
  exit 1
fi

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "请用 root 或 sudo 执行。" >&2
  exit 1
fi

WEB_ROOT=/var/www/fmz-dashboard
SSL_DIR=/etc/ssl/fmz
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NGINX_SRC="$SCRIPT_DIR/nginx-fmz-dashboard.conf"

detect_pkg_mgr() {
  if command -v dnf >/dev/null 2>&1; then
    echo dnf
  elif command -v yum >/dev/null 2>&1; then
    echo yum
  elif command -v apt-get >/dev/null 2>&1; then
    echo apt
  else
    echo "未找到 dnf/yum/apt-get，无法安装依赖。" >&2
    exit 1
  fi
}

PKG_MGR="$(detect_pkg_mgr)"

install_base_pkgs() {
  case "$PKG_MGR" in
    dnf|yum)
      $PKG_MGR install -y nginx openssl curl ca-certificates
      ;;
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq nginx openssl curl ca-certificates
      ;;
  esac
}

install_node20() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi
  case "$PKG_MGR" in
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      $PKG_MGR install -y nodejs
      ;;
    apt)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y -qq nodejs
      ;;
  esac
}

web_owner() {
  case "$PKG_MGR" in
    dnf|yum) echo nginx:nginx ;;
    apt) echo www-data:www-data ;;
  esac
}

apply_nginx_site() {
  sed "s/YOUR_DOMAIN_OR_IP/$DOMAIN/g" "$NGINX_SRC" >"$1"
}

enable_nginx_site_debian() {
  local dst=/etc/nginx/sites-available/fmz-dashboard
  apply_nginx_site "$dst"
  ln -sf "$dst" /etc/nginx/sites-enabled/fmz-dashboard
  rm -f /etc/nginx/sites-enabled/default
}

enable_nginx_site_rhel() {
  # RHEL/TencentOS：无 sites-enabled，用 conf.d；禁用默认站点避免抢 80
  if [[ -f /etc/nginx/conf.d/default.conf ]]; then
    mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.bak.$(date +%s) || true
  fi
  apply_nginx_site /etc/nginx/conf.d/fmz-dashboard.conf
}

maybe_open_firewalld() {
  if systemctl is-active firewalld >/dev/null 2>&1; then
    firewall-cmd --permanent --add-service=http --add-service=https 2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
    echo "已尝试放行 firewalld 的 http/https。"
  fi
}

# RHEL/TencentOS 若开启 SELinux，Nginx 反代外网 HTTPS 需允许出站连接
maybe_selinux_proxy() {
  if command -v setsebool >/dev/null 2>&1 && getenforce 2>/dev/null | grep -qi Enforcing; then
    setsebool -P httpd_can_network_connect 1 2>/dev/null || true
    echo "SELinux Enforcing：已尝试 setsebool httpd_can_network_connect=1（反代 /__fmz_api、/doseeing 需要）。"
  fi
}

certbot_hint() {
  case "$PKG_MGR" in
    dnf|yum)
      echo "Let’s Encrypt（有域名时，TencentOS/RHEL 示例）:"
      echo "  sudo $PKG_MGR install -y certbot python3-certbot-nginx"
      echo "  sudo certbot --nginx -d $DOMAIN"
      ;;
    apt)
      echo "Let’s Encrypt（有域名时）:"
      echo "  sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d $DOMAIN"
      ;;
  esac
}

# --- 主流程 ---

install_base_pkgs

OWNER="$(web_owner)"
mkdir -p "$WEB_ROOT" "$SSL_DIR"
chown -R "$OWNER" "$WEB_ROOT"

if [[ "$BUILD_ON_SERVER" -eq 1 ]]; then
  install_node20
  cd "$REPO_ROOT"
  npm ci
  npm run build
  find "$WEB_ROOT" -mindepth 1 -delete
  cp -a "$REPO_ROOT/dist/." "$WEB_ROOT/"
  chown -R "$OWNER" "$WEB_ROOT"
fi

if [[ ! -f "$SSL_DIR/fullchain.pem" ]]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$SSL_DIR/privkey.pem" \
    -out "$SSL_DIR/fullchain.pem" \
    -subj "/CN=$DOMAIN"
  chmod 640 "$SSL_DIR/privkey.pem"
  chmod 644 "$SSL_DIR/fullchain.pem"
fi

if [[ ! -f "$NGINX_SRC" ]]; then
  echo "找不到 $NGINX_SRC" >&2
  exit 1
fi

case "$PKG_MGR" in
  dnf|yum)
    enable_nginx_site_rhel
    ;;
  apt)
    enable_nginx_site_debian
    ;;
esac

maybe_open_firewalld
maybe_selinux_proxy

nginx -t
systemctl enable nginx
systemctl restart nginx

echo ""
echo "=== 完成（$PKG_MGR / TencentOS 或 Debian 已适配）==="
echo "站点根目录: $WEB_ROOT"
if [[ "$BUILD_ON_SERVER" -ne 1 ]]; then
  echo "若尚未上传前端:本机 npm run build 后"
  echo "  scp -r dist/* root@服务器IP:$WEB_ROOT/"
fi
echo "访问: https://$DOMAIN/ （自签证书浏览器会提示风险）"
certbot_hint

#!/usr/bin/env python3
import json, os, re, sys, time
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFont

API = 'https://graph.facebook.com/v21.0'
AD_ACCOUNT = 'act_2626494197765361'
BUSINESS_ID = '1503476977738083'
PAGE_ID = '1159226187284432'
PIXEL_ID = '1570474537867700'
CAMPAIGN_NAME = 'QY Roam | Sales | SG | Meta Launch'
DAILY_BUDGET_MINOR = 1000  # SGD 10.00 total campaign daily budget
ROOT = Path('/root/qy-roam')
ASSET_DIR = ROOT / 'marketing' / 'live-meta-assets'
ASSET_DIR.mkdir(parents=True, exist_ok=True)


def token():
    txt = Path('/root/.config/qyroam/meta-ads.env').read_text()
    m = re.search(r'^META_ADS_ACCESS_TOKEN=(.+)$', txt, re.M)
    if not m:
        raise RuntimeError('META_ADS_ACCESS_TOKEN missing')
    return m.group(1).strip().strip('"').strip("'")

T = token()


def font(size, bold=False):
    candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    ]
    for p in candidates:
        if Path(p).exists():
            return ImageFont.truetype(p, size=size)
    return ImageFont.load_default()


def draw_common(product, price, subtitle, bullets, cta, out_path, device='phone'):
    W, H = 1080, 1350
    bg = Image.new('RGB', (W, H), '#f7fbff')
    d = ImageDraw.Draw(bg)
    # blue header / clean single-panel creative
    d.rounded_rectangle((50, 45, 1030, 1305), radius=44, fill='#ffffff', outline='#d7e6f7', width=3)
    d.text((95, 90), 'QY ROAM', font=font(56, True), fill='#0a3d91')
    d.text((95, 155), 'STAY CONNECTED, ROAM FREELY', font=font(22, True), fill='#2b66c3')
    d.line((95, 215, 985, 215), fill='#dfeaf7', width=3)
    d.text((95, 270), product, font=font(70, True), fill='#102f66')
    d.text((95, 370), 'from', font=font(40, True), fill='#2b66c3')
    d.text((95, 420), price, font=font(104, True), fill='#f36c21')
    d.text((95, 550), subtitle, font=font(31, True), fill='#20395f')
    y = 630
    for b in bullets:
        d.ellipse((100, y+7, 124, y+31), fill='#2b66c3')
        d.text((145, y), b, font=font(29), fill='#20395f')
        y += 68
    # simple single product illustration, not a collage
    if device == 'phone':
        x1,y1,x2,y2 = 650,360,935,900
        d.rounded_rectangle((x1,y1,x2,y2), radius=45, fill='#111923', outline='#34495e', width=6)
        d.rounded_rectangle((680,405,905,850), radius=28, fill='#f8fbff')
        d.text((715,455),'eSIM',font=font(46,True),fill='#0a3d91')
        d.text((710,525),'Scan QR',font=font(28),fill='#20395f')
        # stylised QR block
        qx,qy=720,590
        for rr in range(7):
            for cc in range(7):
                if (rr*3+cc*5+rr*cc)%4 in (0,1):
                    d.rectangle((qx+cc*23,qy+rr*23,qx+cc*23+17,qy+rr*23+17),fill='#111111')
    else:
        d.rounded_rectangle((650,435,935,825), radius=55, fill='#151a21', outline='#34495e', width=6)
        d.rounded_rectangle((690,495,895,690), radius=22, fill='#0b1726')
        d.text((745,525),'QY ROAM',font=font(30,True),fill='#ffffff')
        d.text((758,585),'WiFi',font=font(48,True),fill='#4db4ff')
        d.text((735,705),'Pocket WiFi',font=font(30),fill='#ffffff')
    d.rounded_rectangle((95, 1040, 600, 1165), radius=34, fill='#0b57d0')
    d.text((135, 1075), cta, font=font(40, True), fill='#ffffff')
    d.text((95, 1215), 'Selected destinations & plans. Terms apply.', font=font(22), fill='#5d6d7e')
    bg.save(out_path, 'JPEG', quality=90, optimize=True)


def make_assets():
    esim = ASSET_DIR / 'qy-roam-esim-s048.jpg'
    wifi = ASSET_DIR / 'qy-roam-wifi-s184.jpg'
    draw_common('Travel eSIM', 'S$0.48/day', 'Buy before you fly',
                ['Activate by QR code', 'Keep your number & WhatsApp', 'Singapore-based support'],
                'Shop eSIM', esim, 'phone')
    draw_common('Pocket WiFi', 'S$1.84/day', 'One router. Multiple devices.',
                ['Singapore delivery', 'Easy return after your trip', 'Share across your travel group'],
                'Rent Pocket WiFi', wifi, 'router')
    return esim, wifi


def post(path, data=None, files=None):
    payload = dict(data or {})
    payload['access_token'] = T
    r = requests.post(f'{API}/{path}', data=payload, files=files, timeout=60)
    try:
        body = r.json()
    except Exception:
        body = {'raw': r.text}
    if not r.ok or 'error' in body:
        raise RuntimeError(f'POST {path} failed: {json.dumps(body)}')
    return body


def get(path, params=None):
    p = dict(params or {})
    p['access_token'] = T
    r = requests.get(f'{API}/{path}', params=p, timeout=60)
    body = r.json()
    if not r.ok or 'error' in body:
        raise RuntimeError(f'GET {path} failed: {json.dumps(body)}')
    return body


def upload_image(path):
    with open(path, 'rb') as f:
        body = post(f'{AD_ACCOUNT}/adimages', files={'filename': (path.name, f, 'image/jpeg')})
    images = body.get('images', {})
    if not images:
        raise RuntimeError(f'No image hash returned for {path}: {body}')
    first = next(iter(images.values()))
    return first['hash']


def find_existing_campaign():
    body = get(f'{AD_ACCOUNT}/campaigns', {'fields':'id,name,status,effective_status','limit':'100'})
    for c in body.get('data', []):
        if c.get('name') == CAMPAIGN_NAME and c.get('status') != 'DELETED':
            return c
    return None


def create_campaign():
    body = post(f'{AD_ACCOUNT}/campaigns', {
        'name': CAMPAIGN_NAME,
        'objective': 'OUTCOME_SALES',
        'status': 'PAUSED',
        'special_ad_categories': '[]',
        'daily_budget': str(DAILY_BUDGET_MINOR),
        'bid_strategy': 'LOWEST_COST_WITHOUT_CAP',
    })
    return body['id']


def create_adset(campaign_id, name):
    targeting = {
        'geo_locations': {'countries': ['SG']},
        'age_min': 21,
        'age_max': 60,
    }
    promoted = {'pixel_id': PIXEL_ID, 'custom_event_type': 'PURCHASE'}
    body = post(f'{AD_ACCOUNT}/adsets', {
        'name': name,
        'campaign_id': campaign_id,
        'billing_event': 'IMPRESSIONS',
        'optimization_goal': 'OFFSITE_CONVERSIONS',
        'destination_type': 'WEBSITE',
        'targeting': json.dumps(targeting),
        'promoted_object': json.dumps(promoted),
        'status': 'PAUSED',
        'regional_regulated_categories': json.dumps(['SINGAPORE_UNIVERSAL']),
    })
    return body['id']


def create_creative(name, image_hash, link, message, headline, desc):
    spec = {
        'page_id': PAGE_ID,
        'link_data': {
            'image_hash': image_hash,
            'link': link,
            'message': message,
            'name': headline,
            'description': desc,
            'call_to_action': {'type': 'SHOP_NOW', 'value': {'link': link}},
        }
    }
    body = post(f'{AD_ACCOUNT}/adcreatives', {
        'name': name,
        'object_story_spec': json.dumps(spec),
    })
    return body['id']


def create_ad(adset_id, name, creative_id):
    body = post(f'{AD_ACCOUNT}/ads', {
        'name': name,
        'adset_id': adset_id,
        'creative': json.dumps({'creative_id': creative_id}),
        'status': 'PAUSED',
    })
    return body['id']


def set_status(object_id, status):
    post(object_id, {'status': status})


def main():
    # Verify token/account before doing anything.
    perms = get('me/permissions').get('data', [])
    granted = {x['permission'] for x in perms if x.get('status') == 'granted'}
    for need in ('ads_management','ads_read','business_management'):
        if need not in granted:
            raise RuntimeError(f'Missing permission: {need}')
    acct = get(AD_ACCOUNT, {'fields':'id,name,currency,timezone_name,account_status'})
    if acct.get('currency') != 'SGD' or acct.get('account_status') != 1:
        raise RuntimeError(f'Unexpected ad account state: {acct}')
    existing = find_existing_campaign()

    esim_img, wifi_img = make_assets()
    esim_hash = upload_image(esim_img)
    wifi_hash = upload_image(wifi_img)

    campaign_id = existing['id'] if existing else create_campaign()
    created = {'campaign_id': campaign_id, 'reused_existing_campaign': bool(existing)}
    try:
        esim_set = create_adset(campaign_id, 'QY Roam | eSIM | Singapore Travellers')
        wifi_set = create_adset(campaign_id, 'QY Roam | Pocket WiFi | Singapore Travellers')
        created.update({'esim_adset_id': esim_set, 'wifi_adset_id': wifi_set})

        esim_url = 'https://qyroam.com/esim?utm_source=meta&utm_medium=paid_social&utm_campaign=qyroam_meta_launch&utm_content=esim_s048'
        wifi_url = 'https://qyroam.com/?utm_source=meta&utm_medium=paid_social&utm_campaign=qyroam_meta_launch&utm_content=wifi_s184#plans'
        esim_creative = create_creative(
            'QY Roam eSIM S$0.48/day', esim_hash, esim_url,
            'Travelling overseas? Get a QY Roam travel eSIM from as low as S$0.48/day on selected plans. Buy before you fly and activate by QR code — no physical SIM swap required.',
            'Travel eSIM from S$0.48/day',
            'Selected destinations & plans. Buy online before you fly.'
        )
        wifi_creative = create_creative(
            'QY Roam Pocket WiFi S$1.84/day', wifi_hash, wifi_url,
            'Travelling soon? Keep your phone, laptop and travel companions connected with one Pocket WiFi. QY Roam launch rates start from S$1.84/day on selected destinations, with Singapore delivery and easy return.',
            'Pocket WiFi from S$1.84/day',
            'One router. Multiple devices. Singapore delivery.'
        )
        created.update({'esim_creative_id': esim_creative, 'wifi_creative_id': wifi_creative})
        esim_ad = create_ad(esim_set, 'QY Roam | eSIM | S$0.48/day', esim_creative)
        wifi_ad = create_ad(wifi_set, 'QY Roam | Pocket WiFi | S$1.84/day', wifi_creative)
        created.update({'esim_ad_id': esim_ad, 'wifi_ad_id': wifi_ad})

        # Activate bottom-up, campaign last. Total campaign budget stays S$10/day.
        set_status(esim_ad, 'ACTIVE')
        set_status(wifi_ad, 'ACTIVE')
        set_status(esim_set, 'ACTIVE')
        set_status(wifi_set, 'ACTIVE')
        set_status(campaign_id, 'ACTIVE')

        time.sleep(2)
        check = get(campaign_id, {'fields':'id,name,status,effective_status,daily_budget,objective'})
        created['campaign_check'] = check
        Path('/root/qy-roam/marketing/meta-launch-result.json').write_text(json.dumps(created, indent=2))
        print(json.dumps(created, indent=2))
    except Exception:
        # Keep campaign paused if setup fails before full launch.
        try:
            set_status(campaign_id, 'PAUSED')
        except Exception:
            pass
        raise

if __name__ == '__main__':
    main()

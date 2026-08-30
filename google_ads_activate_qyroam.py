#!/usr/bin/env python3
import os
from dotenv import load_dotenv
from google.ads.googleads.client import GoogleAdsClient

load_dotenv('/root/.config/qy-google-ads/.env', override=False)
customer_id = os.environ['GOOGLE_ADS_CUSTOMER_ID'].replace('-', '')
client = GoogleAdsClient.load_from_dict({
    'developer_token': os.environ['GOOGLE_ADS_DEVELOPER_TOKEN'],
    'client_id': os.environ['GOOGLE_ADS_CLIENT_ID'],
    'client_secret': os.environ['GOOGLE_ADS_CLIENT_SECRET'],
    'refresh_token': os.environ['GOOGLE_ADS_REFRESH_TOKEN'],
    'use_proto_plus': True,
})

TARGETS = {
    'QY Roam | Pocket WiFi | SG | Launch',
    'QY Roam | Travel eSIM | SG | Launch',
}

ga = client.get_service('GoogleAdsService')
campaign_svc = client.get_service('CampaignService')

q = "SELECT campaign.resource_name, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.name LIKE 'QY Roam |%' AND campaign.status != REMOVED"
rows = list(ga.search(customer_id=customer_id, query=q))
found = {r.campaign.name: r for r in rows if r.campaign.name in TARGETS}
if set(found) != TARGETS:
    raise SystemExit(f'Expected both QY Roam launch campaigns; found {sorted(found)}')

total_daily = sum(r.campaign_budget.amount_micros for r in found.values()) / 1_000_000
if total_daily > 10.00:
    raise SystemExit(f'Refusing activation: combined Google daily budget is S${total_daily:.2f}, above S$10 cap')

ops=[]
for name, row in found.items():
    op = client.get_type('CampaignOperation')
    op.update.resource_name = row.campaign.resource_name
    op.update.status = client.enums.CampaignStatusEnum.ENABLED
    op.update_mask.paths.append('status')
    ops.append(op)

campaign_svc.mutate_campaigns(customer_id=customer_id, operations=ops)

rows2 = list(ga.search(customer_id=customer_id, query=q))
for r in rows2:
    if r.campaign.name in TARGETS:
        print(f'{r.campaign.name}: {r.campaign.status.name} | S${r.campaign_budget.amount_micros/1_000_000:.2f}/day')
print(f'TOTAL_DAILY_CAP: S${total_daily:.2f}/day')

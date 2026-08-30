#!/usr/bin/env python3
import os
from datetime import datetime
from dotenv import load_dotenv
from google.ads.googleads.client import GoogleAdsClient

load_dotenv('/root/.config/qy-google-ads/.env', override=False)
required = [
    'GOOGLE_ADS_DEVELOPER_TOKEN','GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET','GOOGLE_ADS_REFRESH_TOKEN',
    'GOOGLE_ADS_CUSTOMER_ID'
]
missing = [k for k in required if not os.getenv(k)]
if missing:
    raise RuntimeError('Missing env: ' + ', '.join(missing))

customer_id = os.environ['GOOGLE_ADS_CUSTOMER_ID'].replace('-', '')
client = GoogleAdsClient.load_from_dict({
    'developer_token': os.environ['GOOGLE_ADS_DEVELOPER_TOKEN'],
    'client_id': os.environ['GOOGLE_ADS_CLIENT_ID'],
    'client_secret': os.environ['GOOGLE_ADS_CLIENT_SECRET'],
    'refresh_token': os.environ['GOOGLE_ADS_REFRESH_TOKEN'],
    'use_proto_plus': True,
})
svc = client.get_service('CampaignBudgetService')

op = client.get_type('CampaignBudgetOperation')
budget = op.create
budget.name = 'QYROAM_AUTOMATION_CAPABILITY_TEST_' + datetime.utcnow().strftime('%Y%m%d%H%M%S')
budget.amount_micros = 1_000_000
budget.delivery_method = client.enums.BudgetDeliveryMethodEnum.STANDARD
budget.explicitly_shared = False

resp = svc.mutate_campaign_budgets(customer_id=customer_id, operations=[op])
resource_name = resp.results[0].resource_name
print('REAL_WRITE_CREATE: PASS')
print('RESOURCE:', resource_name)

rm = client.get_type('CampaignBudgetOperation')
rm.remove = resource_name
svc.mutate_campaign_budgets(customer_id=customer_id, operations=[rm])
print('REAL_WRITE_CLEANUP: PASS')

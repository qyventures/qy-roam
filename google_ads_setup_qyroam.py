# Idempotent launch setup: any prior QY Roam launch draft resources are removed before recreation.
#!/usr/bin/env python3
import os
from dotenv import load_dotenv
from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException

load_dotenv('/root/.config/qy-google-ads/.env', override=False)
customer_id = os.environ['GOOGLE_ADS_CUSTOMER_ID'].replace('-', '')
client = GoogleAdsClient.load_from_dict({
    'developer_token': os.environ['GOOGLE_ADS_DEVELOPER_TOKEN'],
    'client_id': os.environ['GOOGLE_ADS_CLIENT_ID'],
    'client_secret': os.environ['GOOGLE_ADS_CLIENT_SECRET'],
    'refresh_token': os.environ['GOOGLE_ADS_REFRESH_TOKEN'],
    'use_proto_plus': True,
})

# Safety: setup only. Campaigns remain PAUSED; no spend can occur.
DAILY_BUDGET_SGD = 5.00


def create_budget(name):
    svc = client.get_service('CampaignBudgetService')
    op = client.get_type('CampaignBudgetOperation')
    b = op.create
    b.name = name
    b.amount_micros = int(DAILY_BUDGET_SGD * 1_000_000)
    b.delivery_method = client.enums.BudgetDeliveryMethodEnum.STANDARD
    b.explicitly_shared = False
    res = svc.mutate_campaign_budgets(customer_id=customer_id, operations=[op])
    return res.results[0].resource_name


def create_campaign(name, budget_resource):
    svc = client.get_service('CampaignService')
    op = client.get_type('CampaignOperation')
    c = op.create
    c.name = name
    c.status = client.enums.CampaignStatusEnum.PAUSED
    c.advertising_channel_type = client.enums.AdvertisingChannelTypeEnum.SEARCH
    c.contains_eu_political_advertising = client.enums.EuPoliticalAdvertisingStatusEnum.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING
    c.campaign_budget = budget_resource
    c.manual_cpc.enhanced_cpc_enabled = False
    c.network_settings.target_google_search = True
    c.network_settings.target_search_network = False
    c.network_settings.target_content_network = False
    c.network_settings.target_partner_search_network = False
    res = svc.mutate_campaigns(customer_id=customer_id, operations=[op])
    return res.results[0].resource_name


def add_location_language(campaign_resource):
    svc = client.get_service('CampaignCriterionService')
    ops = []
    # Singapore geo target constant = 2702
    op = client.get_type('CampaignCriterionOperation')
    op.create.campaign = campaign_resource
    op.create.location.geo_target_constant = 'geoTargetConstants/2702'
    ops.append(op)
    # English language constant = 1000
    op = client.get_type('CampaignCriterionOperation')
    op.create.campaign = campaign_resource
    op.create.language.language_constant = 'languageConstants/1000'
    ops.append(op)
    svc.mutate_campaign_criteria(customer_id=customer_id, operations=ops)


def add_negatives(campaign_resource):
    svc = client.get_service('CampaignCriterionService')
    ops=[]
    for kw in ['jobs','careers','free wifi','router repair','home wifi','broadband','login']:
        op = client.get_type('CampaignCriterionOperation')
        crit = op.create
        crit.campaign = campaign_resource
        crit.negative = True
        crit.keyword.text = kw
        crit.keyword.match_type = client.enums.KeywordMatchTypeEnum.PHRASE
        ops.append(op)
    svc.mutate_campaign_criteria(customer_id=customer_id, operations=ops)


def create_ad_group(campaign_resource, name):
    svc = client.get_service('AdGroupService')
    op = client.get_type('AdGroupOperation')
    ag = op.create
    ag.name = name
    ag.campaign = campaign_resource
    ag.status = client.enums.AdGroupStatusEnum.ENABLED
    ag.type_ = client.enums.AdGroupTypeEnum.SEARCH_STANDARD
    ag.cpc_bid_micros = 1_500_000
    res = svc.mutate_ad_groups(customer_id=customer_id, operations=[op])
    return res.results[0].resource_name


def add_keywords(ad_group_resource, keywords):
    svc = client.get_service('AdGroupCriterionService')
    ops=[]
    for text, match in keywords:
        op = client.get_type('AdGroupCriterionOperation')
        crit = op.create
        crit.ad_group = ad_group_resource
        crit.status = client.enums.AdGroupCriterionStatusEnum.ENABLED
        crit.keyword.text = text
        crit.keyword.match_type = getattr(client.enums.KeywordMatchTypeEnum, match)
        ops.append(op)
    svc.mutate_ad_group_criteria(customer_id=customer_id, operations=ops)


def add_rsa(ad_group_resource, final_url, headlines, descriptions):
    svc = client.get_service('AdGroupAdService')
    op = client.get_type('AdGroupAdOperation')
    aga = op.create
    aga.ad_group = ad_group_resource
    aga.status = client.enums.AdGroupAdStatusEnum.ENABLED
    aga.ad.final_urls.append(final_url)
    for h in headlines:
        asset = client.get_type('AdTextAsset')
        asset.text = h
        aga.ad.responsive_search_ad.headlines.append(asset)
    for d in descriptions:
        asset = client.get_type('AdTextAsset')
        asset.text = d
        aga.ad.responsive_search_ad.descriptions.append(asset)
    res = svc.mutate_ad_group_ads(customer_id=customer_id, operations=[op])
    return res.results[0].resource_name


def build_campaign(cfg):
    budget = create_budget(cfg['name'] + ' Budget S$5')
    campaign = create_campaign(cfg['name'], budget)
    add_location_language(campaign)
    add_negatives(campaign)
    ag = create_ad_group(campaign, cfg['ad_group'])
    add_keywords(ag, cfg['keywords'])
    ad = add_rsa(ag, cfg['url'], cfg['headlines'], cfg['descriptions'])
    print('CREATED:', cfg['name'])
    print('  campaign:', campaign)
    print('  budget:', budget, 'S$5/day')
    print('  ad_group:', ag)
    print('  ad:', ad)
    print('  status: PAUSED')


def cleanup_existing():
    ga = client.get_service('GoogleAdsService')
    campaign_svc = client.get_service('CampaignService')
    budget_svc = client.get_service('CampaignBudgetService')

    campaign_ops = []
    q = "SELECT campaign.resource_name, campaign.name, campaign.status FROM campaign WHERE campaign.name LIKE 'QY Roam |%' AND campaign.status != REMOVED"
    for row in ga.search(customer_id=customer_id, query=q):
        op = client.get_type('CampaignOperation')
        op.remove = row.campaign.resource_name
        campaign_ops.append(op)
    if campaign_ops:
        campaign_svc.mutate_campaigns(customer_id=customer_id, operations=campaign_ops)
        print('CLEANUP_CAMPAIGNS:', len(campaign_ops))

    budget_ops = []
    q = "SELECT campaign_budget.resource_name, campaign_budget.name, campaign_budget.status FROM campaign_budget WHERE campaign_budget.name LIKE 'QY Roam |%' AND campaign_budget.status != REMOVED"
    for row in ga.search(customer_id=customer_id, query=q):
        op = client.get_type('CampaignBudgetOperation')
        op.remove = row.campaign_budget.resource_name
        budget_ops.append(op)
    if budget_ops:
        budget_svc.mutate_campaign_budgets(customer_id=customer_id, operations=budget_ops)
        print('CLEANUP_BUDGETS:', len(budget_ops))


cleanup_existing()

configs = [
    {
        'name':'QY Roam | Pocket WiFi | SG | Launch',
        'ad_group':'Pocket WiFi Singapore',
        'url':'https://qyroam.com/?utm_source=google&utm_medium=cpc&utm_campaign=qyroam_launch_2026&utm_content=pocket_wifi#plans',
        'keywords':[
            ('pocket wifi singapore','EXACT'),('travel wifi singapore','EXACT'),('portable wifi rental singapore','EXACT'),
            ('pocket wifi rental','PHRASE'),('wifi router travel','PHRASE'),('japan pocket wifi singapore','PHRASE'),('japan wifi rental','PHRASE')
        ],
        'headlines':['Pocket WiFi From S$1.84/Day','Pocket WiFi For Your Trip','QY Roam Singapore','Share WiFi Across Devices','Delivered Before You Fly','QY10: 10% Off Rental','Japan Pocket WiFi Rental','Book Travel WiFi Online'],
        'descriptions':['Pocket WiFi from S$1.84/day on selected destinations. Singapore delivery and return.','Share one travel router across devices. Use QY10 for 10% off rental.']
    },
    {
        'name':'QY Roam | Travel eSIM | SG | Launch',
        'ad_group':'Travel eSIM Singapore',
        'url':'https://qyroam.com/esim?utm_source=google&utm_medium=cpc&utm_campaign=qyroam_launch_2026&utm_content=esim',
        'keywords':[
            ('travel esim singapore','EXACT'),('esim for travel','EXACT'),('overseas esim singapore','EXACT'),
            ('travel esim','PHRASE'),('international esim','PHRASE'),('japan esim singapore','PHRASE'),('esim japan singapore','PHRASE')
        ],
        'headlines':['Travel eSIM From S$0.48/Day','QY Roam Travel eSIM','eSIM For Your Next Trip','No Router To Return','Buy Before You Fly','Activate By QR Code','Japan & Asia eSIM','Singapore Support'],
        'descriptions':['Travel eSIM from S$0.48/day on selected plans. Buy online before you fly.','Activate by QR code. No physical SIM swap, with Singapore-based support.']
    }
]

try:
    for cfg in configs:
        build_campaign(cfg)
    print('SETUP_COMPLETE: 2 PAUSED campaigns, total planned cap S$10/day when enabled')
except GoogleAdsException as exc:
    print('GOOGLE_ADS_ERROR')
    for err in exc.failure.errors:
        print(err.error_code, err.message)
    raise

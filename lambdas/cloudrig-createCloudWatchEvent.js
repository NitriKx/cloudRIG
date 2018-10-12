exports.handler = (event, context, callback) => {
    var AWS = require("aws-sdk");
    var sns = new AWS.SNS();
    var ec2 = new AWS.EC2();
    var cloudwatchevents = new AWS.CloudWatchEvents();


    var eventBody = JSON.parse(event.Records[0].Sns.Message);
    var lambdaARNQueue = eventBody.lambdaARNQueue;

    function triggerNextLambda() {
        // Trigger next lambda in queue
        if (lambdaARNQueue.length == 0) {
            console.log("No more functions in lambda queue")
        }
        else {
            console.log("Triggering next lambda via SNS");

            var nextFunc = lambdaARNQueue.shift();
            eventBody.lambdaARNQueue = lambdaARNQueue;
            eventBody.args = nextFunc.args;

            console.log("ARN of SNS to be triggered is " + nextFunc);

            sns.publish({
                Message: JSON.stringify(eventBody),
                TopicArn: nextFunc.arn
            }
                , function (err, data) {
                    if (err) {
                        console.log(err);
                        return;
                    }
                    console.log(data);
                });
        }
    }

    function run() {

        var lambda = new AWS.Lambda();
        
        console.log("Creating CloudWatch rule");

        cloudwatchevents.putRule(
            {
                Name: "cloudrig-watch-" + eventBody.state.instance.InstanceId,
                EventPattern: JSON.stringify({
                    source: ["aws.ec2"],
                    "detail-type": ["EC2 Instance State-change Notification"],
                    detail: {
                        state: ["stopped"],
                        "instance-id": [eventBody.state.instance.InstanceId]
                    }
                }),
                State: "ENABLED"
            },
            function (err, ruleData) {
                if (err) {
                    console.log(err);
                    return;
                }

                console.log("Creating CloudWatch target");

                cloudwatchevents.putTargets(
                    {
                        Rule: "cloudrig-watch-" + eventBody.state.instance.InstanceId,
                        Targets: [
                            {
                                Arn: eventBody.settings.lambda.FunctionArn,
                                Id: "1"
                            }
                        ]
                    },
                    function (err) {
                        if (err) {
                            console.log(err);
                            return;
                        }

                        console.log("Giving CloudWatch lambda permission");

                        lambda.addPermission(
                            {
                                Action: "lambda:InvokeFunction",
                                FunctionName: "cloudrig-lambda",
                                Principal: "events.amazonaws.com",
                                SourceArn: ruleData.RuleArn,
                                StatementId: "Statement-" + eventBody.state.instance.InstanceId
                            },
                            function(err,data) {
                                if (err) {
                                    console.log(err);
                                    return;
                                }

                                triggerNextLambda();
                            }
                        );
                    }
                );
            }
        );
    }

    // Disable the schedulelambda rule, since it might have been enabled to
    // trigger this lambda
    cloudwatchevents.disableRule({ Name: "ScheduleLambda" },
        function (err, data) {
            if (err) {
                console.log(err);
            }

            // Check that the instance isn't cancelled/still exists
            ec2.describeTags({
                Filters: [
                    {
                        Name: "resource-id",
                        Values: [
                            eventBody.state.instance.InstanceId
                        ]
                    }
                ]
            },
                function (err, data) {
                    if (err) {
                        console.log(err);
                        return;
                    }

                    if (data.Tags.some(function (tag) {
                        return tag.Key == "cancelled";
                    })) {
                        console.log("Instance marked as cancelled");
                        return;
                    }

                    if (data.Tags.length == 0) { // Instance doesn't exist
                        console.log("Instance not found");
                        return;
                    }

                    run();

                });
        });

};

